// Long-lived Crawl4AI fetch worker — singleton manager for the agent's
// web_fetch tool. Spawns one Python child running
// `kra_docs_worker.py --server` lazily on first request, then keeps it warm
// across subsequent calls so Chromium doesn't pay a cold-start tax every
// time. Idle TTL kills the process when unused; we recycle after a fixed
// number of pages to bound Playwright leak.
//
// Wire from runWebFetch (src/AI/shared/utils/webTools.ts). Falls back to
// Jina/direct on any error.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';

import { loadSettings } from '@/utils/common';
import { crawl4aiVenvPython } from '@/filePaths';
import { docsPythonWorkerPath } from '@/packagePaths';
import { isCrawl4aiInstalled } from '@/AI/AIAgent/commands/docsSetup';

export interface FetchWorkerOptions {
    mode?: 'auto' | 'http' | 'browser',
    pageTimeoutMs?: number,
}

export interface FetchWorkerResult {
    ok: true,
    markdown: string,
    title: string,
    status: number | null,
    mode: 'http' | 'browser',
    coldStart: boolean,
}

interface PendingRequest {
    resolve: (value: FetchWorkerResult) => void,
    reject: (err: Error) => void,
    timer: NodeJS.Timeout,
}

interface ResolvedConfig {
    enabled: boolean,
    idleTimeoutMs: number,
    maxPagesPerWorker: number,
    pageTimeoutMs: number,
    mode: 'auto' | 'http' | 'browser',
    maxConcurrent: number,
}

const DEFAULTS: ResolvedConfig = {
    enabled: true,
    idleTimeoutMs: 600_000,
    maxPagesPerWorker: 50,
    pageTimeoutMs: 15_000,
    mode: 'auto',
    maxConcurrent: 3,
};

let cachedConfig: ResolvedConfig | undefined;
async function getConfig(): Promise<ResolvedConfig> {
    if (cachedConfig) return cachedConfig;
    try {
        const settings = await loadSettings();
        const w = settings.ai?.web ?? {};
        cachedConfig = {
            enabled: w.fetchEnabled ?? DEFAULTS.enabled,
            idleTimeoutMs: w.fetchIdleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
            maxPagesPerWorker: w.fetchMaxPagesPerWorker ?? DEFAULTS.maxPagesPerWorker,
            pageTimeoutMs: w.fetchPageTimeoutMs ?? DEFAULTS.pageTimeoutMs,
            mode: w.fetchMode ?? DEFAULTS.mode,
            maxConcurrent: w.fetchMaxConcurrent ?? DEFAULTS.maxConcurrent,
        };
    } catch {
        cachedConfig = { ...DEFAULTS };
    }

    return cachedConfig;
}

export function _resetFetchWorkerConfigCache(): void {
    cachedConfig = undefined;
}

class FetchWorker {
    private child: ChildProcessWithoutNullStreams | undefined;
    private ready = false;
    private readyPromise: Promise<void> | undefined;
    private pending = new Map<string, PendingRequest>();
    private idleTimer: NodeJS.Timeout | undefined;
    private pagesServed = 0;
    private nextRequestId = 1;
    private inFlight = 0;
    private waitQueue: Array<() => void> = [];
    private spawnsTotal = 0;

    async fetch(url: string, opts: FetchWorkerOptions = {}): Promise<FetchWorkerResult> {
        const cfg = await getConfig();
        if (!cfg.enabled) throw new Error('web fetch worker disabled in settings');
        if (!isCrawl4aiInstalled()) throw new Error('crawl4ai venv not installed');

        await this.acquireSlot(cfg.maxConcurrent);
        try {
            const wasCold = !this.ready;
            await this.ensureChild(cfg);
            const result = await this.sendRequest(url, opts, cfg);
            this.pagesServed += 1;
            this.scheduleIdle(cfg.idleTimeoutMs);
            if (this.pagesServed >= cfg.maxPagesPerWorker) {
                this.recycle('page-limit');
            }

            return { ...result, coldStart: wasCold };
        } finally {
            this.releaseSlot();
        }
    }

    private async acquireSlot(max: number): Promise<void> {
        if (this.inFlight < max) {
            this.inFlight += 1;

            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.waitQueue.push(() => {
                this.inFlight += 1;
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        this.inFlight -= 1;
        const next = this.waitQueue.shift();
        if (next) next();
    }

    private async ensureChild(cfg: ResolvedConfig): Promise<void> {
        if (this.ready && this.child) return;
        if (this.readyPromise) return this.readyPromise;

        this.readyPromise = new Promise<void>((resolve, reject) => {
            const args = [docsPythonWorkerPath, '--server', '--mode', cfg.mode, '--page-timeout-ms', String(cfg.pageTimeoutMs)];
            const child = spawn(crawl4aiVenvPython, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            this.spawnsTotal += 1;
            this.pagesServed = 0;

            const stderrBuf: string[] = [];
            child.stderr.setEncoding('utf-8');
            child.stderr.on('data', (chunk: string) => {
                stderrBuf.push(chunk);
                if (stderrBuf.length > 50) stderrBuf.shift();
            });

            const rl = readline.createInterface({ input: child.stdout });
            rl.on('line', (line) => this.handleLine(line));

            child.on('exit', (code, signal) => {
                this.handleExit(code, signal, stderrBuf.join(''));
            });
            child.on('error', (err) => {
                this.handleExit(null, null, err.message);
                reject(err);
            });

            const readyTimer = setTimeout(() => {
                reject(new Error(`fetch worker did not become ready within 30s; stderr=${stderrBuf.join('').slice(-500)}`));
            }, 30_000);

            this.onReady = () => {
                clearTimeout(readyTimer);
                this.ready = true;
                resolve();
            };
        }).finally(() => {
            this.readyPromise = undefined;
        });

        return this.readyPromise;
    }

    private onReady: (() => void) | undefined;

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: any;
        try { msg = JSON.parse(trimmed); } catch { return; }

        if (msg.type === 'server-ready') {
            if (this.onReady) {
                const cb = this.onReady;
                this.onReady = undefined;
                cb();
            }

            return;
        }
        if (msg.type === 'fetch-result') {
            const id = String(msg.requestId ?? '');
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (msg.ok) {
                pending.resolve({
                    ok: true,
                    markdown: String(msg.markdown ?? ''),
                    title: String(msg.title ?? ''),
                    status: typeof msg.status === 'number' ? msg.status : null,
                    mode: (msg.mode === 'http' || msg.mode === 'browser') ? msg.mode : 'browser',
                    coldStart: false,
                });
            } else {
                pending.reject(new Error(String(msg.error ?? 'unknown worker error')));
            }
        }
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): void {
        this.ready = false;
        this.child = undefined;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        const failure = new Error(`fetch worker exited code=${code} signal=${signal} stderr=${stderrTail.slice(-500)}`);
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(failure);
            this.pending.delete(id);
        }
    }

    private async sendRequest(url: string, opts: FetchWorkerOptions, cfg: ResolvedConfig): Promise<FetchWorkerResult> {
        const child = this.child;
        if (!child) return Promise.reject(new Error('fetch worker not running'));

        const requestId = String(this.nextRequestId++);
        const timeoutMs = (opts.pageTimeoutMs ?? cfg.pageTimeoutMs) + 10_000;

        return new Promise<FetchWorkerResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`fetch worker request ${requestId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });

            const payload: Record<string, unknown> = { requestId, url };
            if (opts.mode) payload['mode'] = opts.mode;
            if (opts.pageTimeoutMs) payload['pageTimeoutMs'] = opts.pageTimeoutMs;
            try {
                child.stdin.write(JSON.stringify(payload) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private scheduleIdle(idleMs: number): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.pending.size === 0 && this.inFlight === 0) {
                this.recycle('idle-ttl');
            }
        }, idleMs);
        this.idleTimer.unref();
    }

    private recycle(_reason: string): void {
        const child = this.child;
        if (!child) return;
        try {
            child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
            child.stdin.end();
        } catch { /* ignore */ }
        // give it a moment to shut down cleanly; force-kill after 2s
        const killTimer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, 2_000);
        killTimer.unref();
    }

    // For tests: state inspection
    _stats() {
        return {
            ready: this.ready,
            pagesServed: this.pagesServed,
            inFlight: this.inFlight,
            spawnsTotal: this.spawnsTotal,
            pending: this.pending.size,
        };
    }

    _shutdown(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        this.recycle('explicit-shutdown');
    }
}

let singleton: FetchWorker | undefined;

export function getFetchWorker(): FetchWorker {
    if (!singleton) singleton = new FetchWorker();

    return singleton;
}

export function _resetFetchWorker(): void {
    if (singleton) singleton._shutdown();
    singleton = undefined;
}

// Best-effort cleanup on process exit so we don't leave orphan Pythons.
process.on('exit', () => {
    if (singleton) singleton._shutdown();
});
