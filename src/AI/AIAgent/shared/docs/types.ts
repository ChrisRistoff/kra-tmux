// IPC and ingest types for the docs coordinator.
//
// Wire format on both ends is JSON:
//   - CLI -> coordinator: a single JSON-encoded `DocsClientMessage` written
//     via the existing `IPCClient.emit` (one connection per message).
//   - Worker -> coordinator: JSON Lines over the worker's stdout
//     (one `DocsWorkerMessage` per line). Workers are spawned as child
//     processes by the coordinator, so stdout is read directly.
//   - Coordinator -> CLI status: read from a periodically-written status
//     file at `~/.kra/.kra-memory/docs/docs-status.json`. No reply channel on
//     the IPC socket itself.

export type DocsSourceRequest = {
    type: 'source-enqueue',
    alias: string,
    url: string,
    maxDepth?: number,
    maxPages?: number,
    includePatterns?: string[],
    excludePatterns?: string[],
    bypassIncremental?: boolean,
    mode?: 'auto' | 'http' | 'browser',
    concurrency?: number,
    pageTimeoutMs?: number,
};

export type DocsClientMessage =
    | DocsSourceRequest
    | { type: 'shutdown-request' };

export type DocsWorkerMessage =
    | { type: 'worker-ready', alias: string, pid: number }
    | { type: 'mode-decided', alias: string, mode: 'http' | 'browser', reason: string }
    | { type: 'page-fetched', alias: string, url: string, title: string, markdown: string, links: string[], hash: string, etag?: string, lastModified?: string }
    | { type: 'page-unchanged', alias: string, url: string, pageHash: string, etag?: string, lastModified?: string }
    | { type: 'page-skipped', alias: string, url: string, reason: 'sitemap-unchanged' | 'http-not-modified' }
    | { type: 'worker-progress', alias: string, pagesDone: number, pagesTotal: number, currentUrl: string }
    | { type: 'worker-error', alias: string, url?: string, error: string, fatal: boolean }
    | { type: 'source-done', alias: string, summary: { pagesScraped: number, pagesSkipped: number, chunksWritten: number, elapsedMs: number } };

export type DocsSourcePhase =
    | 'queued'
    | 'crawling'
    | 'embedding'
    | 'done'
    | 'error';

export type DocsSourceStatus = {
    alias: string,
    phase: DocsSourcePhase,
    pagesDone: number,
    pagesTotal: number,
    chunksWritten: number,
    errors: number,
    startedAt?: number,
    finishedAt?: number,
    lastUrl?: string,
    lastError?: string,
    mode?: 'http' | 'browser',
};

export type DocsStatusFile = {
    coordinatorPid: number,
    startedAt: number,
    updatedAt: number,
    sources: DocsSourceStatus[],
};

export type DocChunkRow = {
    id: string,
    sourceAlias: string,
    url: string,
    pageTitle: string,
    sectionPath: string,
    chunkIndex: number,
    tokenCount: number,
    content: string,
    contentHash: string,
    indexedAt: number,
    vector: number[],
};

// Per-page state used to short-circuit re-crawls.
export type DocsPageState = {
    etag?: string,
    lastModified?: string,
    lastIndexedAt: number,
    pageHash: string,
    chunkCount: number,
};

// Persisted to ~/.kra/.kra-memory/docs/docs-state.json (global).
export type DocsStateFile = {
    version: 1,
    pages: Record<string, DocsPageState>,
};

export function pageStateKey(alias: string, url: string): string {
    return `${alias}|${url}`;
}
