/**
 * fastembed wrapper for the kra-memory layer.
 *
 * Runs fastembed in a SEPARATE OS process (`child_process.fork`) so that
 * after `embedderIdleTimeoutMs` of inactivity we can `kill()` the child
 * and the kernel reclaims the full ~450 MB ONNX runtime arena. In-process
 * approaches (cachedModel = null, session.release(), worker_threads) all
 * leave pages mapped to the parent PID on macOS — only a separate process
 * gives guaranteed RSS return-to-OS.
 *
 * Behavior:
 *   1. Child is forked lazily on the first embed call.
 *   2. After `embedderIdleTimeoutMs` of no activity (default 60 s, 0
 *      disables) the child is killed. The next embed call respawns.
 *   3. Re-spawn cost is dominated by FlagEmbedding.init() (~160 ms once
 *      the model file is cached on disk) plus ~80 ms node boot.
 *
 * Configuration:
 *   - `[ai.agent.memory] embedder_idle_timeout_ms` in settings.toml
 *   - `KRA_MEMORY_MODEL_CACHE` env var overrides the on-disk cache dir
 */

import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { kraHome } from '@/filePaths';
import { loadMemorySettings } from './settings';

export const VECTOR_DIM = 384;

type PendingResponse = {
    resolve: (vectors: number[][]) => void;
    reject: (err: Error) => void;
};

type ChildMessage =
    | { type: 'ready' }
    | { type: 'result'; id: number; vectors: number[][] }
    | { type: 'error'; id: number; message: string };

let cachedChild: ChildProcess | null = null;
let pendingChild: Promise<ChildProcess> | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingResponse>();

let idleTimer: NodeJS.Timeout | null = null;
let cachedIdleTimeoutMs: number | null = null;

let embedQueue: Promise<unknown> = Promise.resolve();

function defaultCacheDir(): string {
    const override = process.env['KRA_MEMORY_MODEL_CACHE'];
    if (override && override.length > 0) return override;

    return path.join(kraHome(), 'cache', 'fastembed');
}

async function getIdleTimeoutMs(): Promise<number> {
    if (cachedIdleTimeoutMs !== null) return cachedIdleTimeoutMs;
    try {
        const settings = await loadMemorySettings();
        cachedIdleTimeoutMs = settings.embedderIdleTimeoutMs;
    } catch {
        cachedIdleTimeoutMs = 60_000;
    }

    return cachedIdleTimeoutMs;
}

function clearIdleTimer(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function rejectAllPending(reason: Error): void {
    for (const p of pendingRequests.values()) {
        p.reject(reason);
    }
    pendingRequests.clear();
}

function childScriptPath(): string {
    // After tsc, this file lives at dest/src/AI/AIAgent/shared/memory/embedder.js
    // and the child is its sibling embedderChild.js.
    return path.join(__dirname, 'embedderChild.js');
}

function spawnChild(): Promise<ChildProcess> {
    if (pendingChild) return pendingChild;
    if (cachedChild) return Promise.resolve(cachedChild);

    pendingChild = new Promise<ChildProcess>((resolve, reject) => {
        const cp = fork(childScriptPath(), [], {
            env: {
                ...process.env,
                KRA_EMBEDDER_CACHE_DIR: defaultCacheDir(),
            },
            // Inherit stdio so child errors show up in parent logs.
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            // Don't keep parent's event loop alive just for the child.
            detached: false,
        });

        let ready = false;

        cp.on('message', (msg: ChildMessage) => {
            if (msg.type === 'ready') {
                ready = true;
                cachedChild = cp;
                pendingChild = null;
                resolve(cp);

                return;
            }
            if (msg.type === 'result') {
                const p = pendingRequests.get(msg.id);
                if (p) {
                    pendingRequests.delete(msg.id);
                    p.resolve(msg.vectors);
                }

                return;
            }
            if (msg.type === 'error') {
                const p = pendingRequests.get(msg.id);
                if (p) {
                    pendingRequests.delete(msg.id);
                    p.reject(new Error(msg.message));
                }
            }
        });

        cp.on('error', (err) => {
            if (!ready) {
                pendingChild = null;
                reject(err);
            }
            rejectAllPending(err);
            cachedChild = null;
        });

        cp.on('exit', (code, signal) => {
            cachedChild = null;
            pendingChild = null;
            if (pendingRequests.size > 0) {
                rejectAllPending(new Error(`embedderChild exited (code=${code}, signal=${signal}) with pending requests`));
            }
        });

        // Don't keep parent alive solely for this child.
        try { cp.unref(); } catch { /* noop */ }
        try { cp.channel?.unref(); } catch { /* noop */ }
    });

    return pendingChild;
}

function killChild(cp: ChildProcess): void {
    // Try graceful disconnect first (the child has a 'disconnect' handler
    // that exits cleanly), then SIGTERM, then SIGKILL.
    try { cp.disconnect(); } catch { /* noop */ }
    try { cp.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => {
        try {
            if (!cp.killed && cp.exitCode === null) {
                cp.kill('SIGKILL');
            }
        } catch { /* noop */ }
    }, 1000).unref();
}

async function scheduleIdleUnload(): Promise<void> {
    clearIdleTimer();
    const ms = await getIdleTimeoutMs();
    if (ms <= 0) return;

    idleTimer = setTimeout(() => {
        idleTimer = null;
        const cp = cachedChild;
        cachedChild = null;
        if (!cp) return;
        killChild(cp);
    }, ms);

    if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/**
 * Embed a single string. Returns a plain `number[]` so it can be passed
 * directly to LanceDB without Arrow conversion gymnastics.
 */
export async function embedOne(text: string): Promise<number[]> {
    const results = await embedMany([text]);
    if (results.length === 0) {
        throw new Error('embedOne: fastembed returned no vectors');
    }

    return results[0];
}

/**
 * Embed a batch of strings. Order of returned vectors matches input order.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    clearIdleTimer();

    const next = embedQueue.then(async () => {
        const cp = await spawnChild();
        const id = nextRequestId++;

        return new Promise<number[][]>((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject });
            try {
                cp.send({ type: 'embed', id, texts }, (err) => {
                    if (err) {
                        pendingRequests.delete(id);
                        reject(err);
                    }
                });
            } catch (err) {
                pendingRequests.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });

    embedQueue = next
        .catch(() => undefined)
        .then(() => { void scheduleIdleUnload(); });

    return next;
}

/**
 * Test/diagnostic hook: kill the child immediately. Safe to call anytime;
 * in-flight `embedMany` calls will be rejected.
 */
export function __unloadEmbedderForTests(): void {
    clearIdleTimer();
    cachedIdleTimeoutMs = null;
    const cp = cachedChild;
    cachedChild = null;
    pendingChild = null;
    if (cp) killChild(cp);
}

// Make sure we don't orphan the child if the parent crashes hard.
process.once('exit', () => {
    const cp = cachedChild;
    if (cp) {
        try { cp.kill('SIGTERM'); } catch { /* noop */ }
    }
});
