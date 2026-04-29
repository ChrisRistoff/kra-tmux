// Docs coordinator — long-lived process that owns the LanceDB writer.
//
// Spawned on demand by `kra ai docs` via `IPCClient.ensureServerRunning`.
// Lifecycle:
//   1. Acquire `LockFiles.DocsWriteInProgress`. Refresh every 30 s while
//      alive so a crashed coordinator's lock goes stale and is reclaimed.
//   2. Listen on `IPCsockets.DocsCoordinatorSocket` for `source-enqueue`
//      messages (JSON payloads) from CLI invocations.
//   3. Maintain an in-memory queue of sources. Up to
//      `[ai.docs] maxConcurrentSources` Python workers run in parallel.
//   4. Each worker is `~/.kra/crawl4ai-venv/bin/python kra_docs_worker.py`,
//      streaming JSONL to its stdout. The coordinator parses each line as
//      a `DocsWorkerMessage` and ingests `page-fetched` events.
//   5. Status snapshot is written to
//      `<repo>/.kra-memory/docs-status.json` every 2 s for the
//      `kra ai docs` live progress screen (no IPC reply path needed).
//   6. After the queue drains and stays empty for `idleTimeoutMs`, the
//      coordinator releases the lock, removes the status file, and exits.

import 'module-alias/register';

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';

import { loadSettings } from '@/utils/common';
import { crawl4aiInstalledMarker, crawl4aiVenvPython } from '@/filePaths';
import { docsPythonWorkerPath } from '@/packagePaths';
import { createIPCServer, IPCsockets, type IPCServer } from '../../../../../eventSystem/ipc';
import {
    LockFiles,
    createLockFile,
    deleteLockFile,
} from '../../../../../eventSystem/lockFiles';
import { ingestPage, removeSource } from './ingest';
import {
    loadDocsState,
    saveDocsState,
    knownPagesForAlias,
    applyPageFetched,
    applyPageUnchanged,
    applyPageSkipped,
    dropAliasState,
} from './state';
import { memoryDirectoryRoot } from '../memory/db';
import type {
    DocsClientMessage,
    DocsSourcePhase,
    DocsSourceRequest,
    DocsSourceStatus,
    DocsStateFile,
    DocsStatusFile,
    DocsWorkerMessage,
} from './types';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const LOCK_REFRESH_MS = 30_000;
const STATUS_FLUSH_MS = 2_000;

interface QueueEntry extends DocsSourceRequest {}

const docsState: DocsStateFile = loadDocsState();

const queue: QueueEntry[] = [];
const enqueuedAliases = new Set<string>();
const activeAliases = new Set<string>();
const statuses = new Map<string, DocsSourceStatus>();

let server: IPCServer | undefined;
let lockRefreshTimer: NodeJS.Timeout | undefined;
let idleExitTimer: NodeJS.Timeout | undefined;
let statusFlushTimer: NodeJS.Timeout | undefined;
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
const startedAt = Date.now();
let shuttingDown = false;

function statusFilePath(): string {
    return path.join(memoryDirectoryRoot(), 'docs-status.json');
}

function writeStatusFile(): void {
    try {
        const snapshot: DocsStatusFile = {
            coordinatorPid: process.pid,
            startedAt,
            updatedAt: Date.now(),
            sources: Array.from(statuses.values()),
        };
        fs.mkdirSync(memoryDirectoryRoot(), { recursive: true });
        fs.writeFileSync(statusFilePath(), JSON.stringify(snapshot, null, 2));
    } catch (err) {
        console.error('docs-coordinator: failed to write status file', err);
    }
}

function removeStatusFile(): void {
    try {
        if (fs.existsSync(statusFilePath())) fs.unlinkSync(statusFilePath());
    } catch { /* ignore */ }
}

function ensureStatus(alias: string, phase: DocsSourcePhase): DocsSourceStatus {
    let s = statuses.get(alias);
    if (!s) {
        s = {
            alias,
            phase,
            pagesDone: 0,
            pagesTotal: 0,
            chunksWritten: 0,
            errors: 0,
        };
        statuses.set(alias, s);
    }
    return s;
}

function scheduleIdleExit(): void {
    if (idleExitTimer) clearTimeout(idleExitTimer);
    idleExitTimer = setTimeout(() => {
        if (queue.length === 0 && activeAliases.size === 0) {
            shutdown(0);
        }
    }, idleTimeoutMs);
}

function cancelIdleExit(): void {
    if (idleExitTimer) {
        clearTimeout(idleExitTimer);
        idleExitTimer = undefined;
    }
}

function enqueueSource(req: DocsSourceRequest): 'accepted' | 'duplicate' {
    if (enqueuedAliases.has(req.alias)) {
        return 'duplicate';
    }
    enqueuedAliases.add(req.alias);
    queue.push(req);
    ensureStatus(req.alias, 'queued');
    cancelIdleExit();
    pump();
    return 'accepted';
}

function pump(): void {
    while (activeAliases.size < maxConcurrent && queue.length > 0) {
        const next = queue.shift()!;
        runSource(next).catch((err) => {
            console.error(`docs-coordinator: source ${next.alias} crashed`, err);
            const s = ensureStatus(next.alias, 'error');
            s.phase = 'error';
            s.errors += 1;
            s.lastError = String(err);
            s.finishedAt = Date.now();
            activeAliases.delete(next.alias);
            enqueuedAliases.delete(next.alias);
            pump();
            if (queue.length === 0 && activeAliases.size === 0) {
                scheduleIdleExit();
            }
        });
    }
}

function workerArgs(req: DocsSourceRequest): string[] {
    const args = [
        docsPythonWorkerPath,
        '--alias', req.alias,
        '--url', req.url,
        '--max-depth', String(req.maxDepth ?? 0),
        '--max-pages', String(req.maxPages ?? 50),
        '--mode', req.mode ?? 'auto',
        '--page-timeout-ms', String(req.pageTimeoutMs ?? 20000),
    ];

    if (req.concurrency !== undefined) {
        args.push('--concurrency', String(req.concurrency));
    }
    for (const p of req.includePatterns ?? []) {
        args.push('--include', p);
    }
    for (const p of req.excludePatterns ?? []) {
        args.push('--exclude', p);
    }
    return args;
}

async function runSource(req: DocsSourceRequest): Promise<void> {
    activeAliases.add(req.alias);
    const status = ensureStatus(req.alias, 'crawling');
    status.phase = 'crawling';
    status.startedAt = Date.now();
    status.errors = 0;
    status.pagesDone = 0;
    status.chunksWritten = 0;

    // A re-crawl replaces all rows for this source. Doing the wipe up-front
    // Only wipe the source up-front when the user explicitly opted out of
    // incremental updates. Otherwise we rely on per-url upserts in ingestPage
    // so unchanged pages keep their existing rows.
    if (req.bypassIncremental) {
        try {
            await removeSource(req.alias);
            dropAliasState(docsState, req.alias);
        } catch (err) {
            console.error(`docs-coordinator: removeSource(${req.alias}) failed`, err);
        }
    }

    const knownPages = req.bypassIncremental ? {} : knownPagesForAlias(docsState, req.alias);
    const child = spawn(crawl4aiVenvPython, workerArgs(req), {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
        child.stdin.write(JSON.stringify({ knownPages, bypassIncremental: !!req.bypassIncremental }) + '\n');
        child.stdin.end();
    } catch (err) {
        console.error(`docs-coordinator: failed to send stdin payload to ${req.alias} worker`, err);
    }

    const stderrLines: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
        stderrLines.push(chunk);
        if (stderrLines.length > 50) stderrLines.shift();
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
        handleWorkerLine(req, line).catch((err) => {
            console.error(`docs-coordinator: ingest error for ${req.alias}`, err);
            status.errors += 1;
            status.lastError = String(err);
        });
    });

    await new Promise<void>((resolve) => {
        child.on('close', (code, signal) => {
            const finished = ensureStatus(req.alias, status.phase);
            finished.finishedAt = Date.now();
            if (code !== 0 && finished.phase !== 'done') {
                finished.phase = 'error';
                finished.errors += 1;
                finished.lastError = `worker exited with code=${code} signal=${signal}\n${stderrLines.join('').slice(-500)}`;
            }
            resolve();
        });
        child.on('error', (err) => {
            const finished = ensureStatus(req.alias, 'error');
            finished.phase = 'error';
            finished.errors += 1;
            finished.lastError = `failed to spawn worker: ${err.message}`;
            finished.finishedAt = Date.now();
            resolve();
        });
    });

    activeAliases.delete(req.alias);
    enqueuedAliases.delete(req.alias);
    writeStatusFile();
    pump();

    if (queue.length === 0 && activeAliases.size === 0) {
        scheduleIdleExit();
    }
}

async function handleWorkerLine(req: DocsSourceRequest, line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: DocsWorkerMessage;
    try {
        msg = JSON.parse(trimmed) as DocsWorkerMessage;
    } catch {
        console.error(`docs-coordinator: bad JSONL from worker ${req.alias}: ${trimmed.slice(0, 200)}`);
        return;
    }

    const status = ensureStatus(req.alias, 'crawling');

    switch (msg.type) {
        case 'worker-ready':
            return;
        case 'worker-progress': {
            status.pagesDone = msg.pagesDone;
            status.pagesTotal = Math.max(status.pagesTotal, msg.pagesTotal);
            status.lastUrl = msg.currentUrl;
            return;
        }
        case 'worker-error': {
            status.errors += 1;
            status.lastError = msg.error;
            if (msg.fatal) {
                status.phase = 'error';
            }
            return;
        }
        case 'mode-decided': {
            status.mode = msg.mode;
            return;
        }
        case 'page-fetched': {
            status.phase = 'embedding';
            try {
                const result = await ingestPage({
                    alias: req.alias,
                    url: msg.url,
                    title: msg.title,
                    markdown: msg.markdown,
                    indexedAt: Date.now(),
                });
                status.chunksWritten += result.chunksWritten;
                applyPageFetched(docsState, req.alias, msg.url, {
                    pageHash: result.pageHash,
                    chunkCount: result.chunksWritten,
                    indexedAt: Date.now(),
                    ...(msg.etag ? { etag: msg.etag } : {}),
                    ...(msg.lastModified ? { lastModified: msg.lastModified } : {}),
                });
            } catch (err) {
                status.errors += 1;
                status.lastError = `ingest failed for ${msg.url}: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                status.phase = 'crawling';
            }
            return;
        }
        case 'page-unchanged': {
            status.pagesDone += 1;
            applyPageUnchanged(docsState, req.alias, msg.url, {
                pageHash: msg.pageHash,
                indexedAt: Date.now(),
                ...(msg.etag ? { etag: msg.etag } : {}),
                ...(msg.lastModified ? { lastModified: msg.lastModified } : {}),
            });
            return;
        }
        case 'page-skipped': {
            status.pagesDone += 1;
            applyPageSkipped(docsState, req.alias, msg.url, Date.now());
            return;
        }
        case 'source-done': {
            status.phase = 'done';
            status.finishedAt = Date.now();
            status.pagesDone = msg.summary.pagesScraped + msg.summary.pagesSkipped;
            saveDocsState(docsState);
            return;
        }
    }
}

function handleClientMessage(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    let msg: DocsClientMessage;
    try {
        msg = JSON.parse(trimmed) as DocsClientMessage;
    } catch {
        console.error('docs-coordinator: invalid client message', trimmed.slice(0, 200));
        return;
    }

    switch (msg.type) {
        case 'source-enqueue':
            enqueueSource(msg);
            return;
        case 'shutdown-request':
            shutdown(0);
            return;
    }
}

function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;

    if (lockRefreshTimer) clearInterval(lockRefreshTimer);
    if (statusFlushTimer) clearInterval(statusFlushTimer);
    if (idleExitTimer) clearTimeout(idleExitTimer);

    try { server?.close(); } catch { /* ignore */ }

    deleteLockFile(LockFiles.DocsWriteInProgress).finally(() => {
        removeStatusFile();
        process.exit(code);
    });
}

async function main(): Promise<void> {
    if (!fs.existsSync(crawl4aiInstalledMarker)) {
        console.error('docs-coordinator: Crawl4AI venv not installed. Run `kra ai docs setup` first.');
        process.exit(2);
    }
    if (!fs.existsSync(crawl4aiVenvPython)) {
        console.error(`docs-coordinator: missing python at ${crawl4aiVenvPython}. Re-run \`kra ai docs setup\`.`);
        process.exit(2);
    }

    const settings = await loadSettings();
    const docsCfg = settings?.ai?.docs;
    maxConcurrent = Math.max(1, docsCfg?.maxConcurrentSources ?? DEFAULT_MAX_CONCURRENT);
    idleTimeoutMs = Math.max(5_000, docsCfg?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

    await createLockFile(LockFiles.DocsWriteInProgress);
    lockRefreshTimer = setInterval(() => {
        createLockFile(LockFiles.DocsWriteInProgress).catch(() => undefined);
    }, LOCK_REFRESH_MS);
    lockRefreshTimer.unref();

    statusFlushTimer = setInterval(() => writeStatusFile(), STATUS_FLUSH_MS);
    statusFlushTimer.unref();
    writeStatusFile();

    server = createIPCServer(IPCsockets.DocsCoordinatorSocket);
    await server.addListener((event) => handleClientMessage(event));

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    scheduleIdleExit();
}

main().catch((err) => {
    console.error('docs-coordinator: fatal', err);
    shutdown(1);
});
