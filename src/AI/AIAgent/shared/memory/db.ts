/**
 * LanceDB connections for the kra-memory layer.
 *
 * Storage layout (centralized under ~/.kra/.kra-memory):
 *   ~/.kra/.kra-memory/repos/<repoKey>/lance/   ← per-repo: code_chunks, memory_findings, memory_revisits
 *   ~/.kra/.kra-memory/docs/lance/              ← global: doc_chunks (shared by all repos)
 *
 * <repoKey> is sha256(identity)[:16] where identity is the git origin URL
 * (preferred) or the absolute repo top-level path. Resolved once per
 * process via `resolveRepoStorage()` from WORKING_DIR/cwd.
 *
 * Tables are created lazily on first write. We rely on LanceDB's row-based
 * schema inference rather than declaring an Arrow schema up front.
 */

import path from 'path';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { ensureContentFtsIndex } from './hybridSearch';
import type { CodeChunkRow, MemoryRow } from './types';
import type { DocChunkRow } from '../docs/types';
import { _resetRepoStorageCacheForTest, resolveRepoStorage, repoStorageDirForKey } from './repoKey';
import { kraDocsLanceRoot, kraDocsRoot } from '@/filePaths';

const MEMORY_FINDINGS_TABLE = 'memory_findings';
const MEMORY_REVISITS_TABLE = 'memory_revisits';

// Per-process caches keyed by repoKey so a single process can hold open
// connections / tables for several repos simultaneously (multi-repo search).
const dbCache: Map<string, Connection> = new Map();
let docsDbCache: Connection | null = null;
const memoryFindingsTableCache: Map<string, Table> = new Map();
const memoryRevisitsTableCache: Map<string, Table> = new Map();
const codeChunksTableCache: Map<string, Table> = new Map();
const codeFtsEnsuredKeys: Set<string> = new Set();
const docFtsEnsuredKeys: Set<string> = new Set();
const DOC_FTS_KEY = 'doc_chunks';
let docChunksTableCache: Table | null = null;
const legacyDropAttemptedKeys: Set<string> = new Set();

const CODE_CHUNKS_TABLE = 'code_chunks';
const DOC_CHUNKS_TABLE = 'doc_chunks';
const LEGACY_MEMORY_TABLE = 'memory';

async function memoryRoot(repoKey?: string): Promise<string> {
    if (repoKey) {
        return repoStorageDirForKey(repoKey);
    }
    const info = await resolveRepoStorage();

    return info.repoStorageDir;
}

async function lanceRoot(repoKey?: string): Promise<string> {
    return path.join(await memoryRoot(repoKey), 'lance');
}

async function resolveRepoKey(repoKey?: string): Promise<string> {
    if (repoKey) return repoKey;
    const info = await resolveRepoStorage();

    return info.repoKey;
}

async function getDb(repoKey?: string): Promise<Connection> {
    const key = await resolveRepoKey(repoKey);
    const cached = dbCache.get(key);
    if (cached) {
        return cached;
    }

    const conn = await connect(await lanceRoot(key));
    dbCache.set(key, conn);
    if (!legacyDropAttemptedKeys.has(key)) {
        legacyDropAttemptedKeys.add(key);
        try {
            const names = await conn.tableNames();
            if (names.includes(LEGACY_MEMORY_TABLE)) {
                await conn.dropTable(LEGACY_MEMORY_TABLE);
            }
        } catch {
            // best-effort cleanup; ignore failures
        }
    }

    return conn;
}

async function getDocsDb(): Promise<Connection> {
    if (docsDbCache) {
        return docsDbCache;
    }

    docsDbCache = await connect(kraDocsLanceRoot);

    return docsDbCache;
}

let mutex: Promise<unknown> = Promise.resolve();

export interface GetMemoryTableResult {
    table: Table | null;
    justCreated: boolean;
}

async function getOrCreateMemoryTable(
    tableName: string,
    cache: Map<string, Table>,
    seedRow: MemoryRow | null,
    repoKey?: string,
): Promise<GetMemoryTableResult> {
    const key = await resolveRepoKey(repoKey);
    const cached = cache.get(key);
    if (cached) {
        return { table: cached, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetMemoryTableResult> => {
        const c = cache.get(key);
        if (c) {
            return { table: c, justCreated: false };
        }

        const db = await getDb(key);
        const tableNames = await db.tableNames();

        if (tableNames.includes(tableName)) {
            const t = await db.openTable(tableName);
            cache.set(key, t);

            return { table: t, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        const t = await db.createTable(tableName, [seedRow as unknown as Record<string, unknown>]);
        cache.set(key, t);

        return { table: t, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

export async function getFindingsTable(seedRow: MemoryRow | null, repoKey?: string): Promise<GetMemoryTableResult> {
    return getOrCreateMemoryTable(
        MEMORY_FINDINGS_TABLE,
        memoryFindingsTableCache,
        seedRow,
        repoKey,
    );
}

export async function getRevisitsTable(seedRow: MemoryRow | null, repoKey?: string): Promise<GetMemoryTableResult> {
    return getOrCreateMemoryTable(
        MEMORY_REVISITS_TABLE,
        memoryRevisitsTableCache,
        seedRow,
        repoKey,
    );
}

/**
 * Test-only reset of the in-process cache. Not exported via index.
 */
export function _resetCachesForTest(): void {
    dbCache.clear();
    docsDbCache = null;
    memoryFindingsTableCache.clear();
    memoryRevisitsTableCache.clear();
    codeChunksTableCache.clear();
    codeFtsEnsuredKeys.clear();
    docFtsEnsuredKeys.clear();
    docChunksTableCache = null;
    legacyDropAttemptedKeys.clear();
    _resetRepoStorageCacheForTest();
}

/**
 * Returns the central per-repo storage root used by the kra-memory layer
 * (`~/.kra/.kra-memory/repos/<repoKey>/`). The repo identity is resolved
 * from `WORKING_DIR` (set by the parent process when the MCP server is
 * spawned) or `process.cwd()` for direct calls.
 */
export async function memoryDirectoryRoot(repoKey?: string): Promise<string> {
    return memoryRoot(repoKey);
}

/**
 * Returns the global docs storage root (`~/.kra/.kra-memory/docs/`).
 * doc_chunks LanceDB, docs-state.json and docs-status.json are shared
 * across all repos because external doc corpora are not repo-specific.
 */
export function docsDirectoryRoot(): string {
    return kraDocsRoot;
}


export interface GetCodeChunksTableResult {
    table: Table | null;
    justCreated: boolean;
}

/**
 * Returns the code_chunks table. Pass a seed row when about to write so the
 * table can be created on first use; pass `null` for read-only callers and
 * handle `table === null`.
 */
export async function getCodeChunksTable(seedRow: CodeChunkRow | null, repoKey?: string): Promise<GetCodeChunksTableResult> {
    const key = await resolveRepoKey(repoKey);
    const cached = codeChunksTableCache.get(key);
    if (cached) {
        return { table: cached, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetCodeChunksTableResult> => {
        const cachedInner = codeChunksTableCache.get(key);
        if (cachedInner) {
            return { table: cachedInner, justCreated: false };
        }

        const db = await getDb(key);
        const tableNames = await db.tableNames();

        if (tableNames.includes(CODE_CHUNKS_TABLE)) {
            const t = await db.openTable(CODE_CHUNKS_TABLE);
            codeChunksTableCache.set(key, t);
void ensureContentFtsIndex(t, key, codeFtsEnsuredKeys);

            return { table: t, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        const t = await db.createTable(
            CODE_CHUNKS_TABLE,
            [seedRow as unknown as Record<string, unknown>],
        );
        codeChunksTableCache.set(key, t);
void ensureContentFtsIndex(t, key, codeFtsEnsuredKeys);

        return { table: t, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

/**
 * Total number of code chunks currently stored. Returns 0 if the table has
 * never been created.
 */
export async function countCodeChunks(repoKey?: string): Promise<number> {
    const { table } = await getCodeChunksTable(null, repoKey);

    if (!table) return 0;

    try {
        return await table.countRows();
    } catch {
        return 0;
    }
}

export interface GetDocChunksTableResult {
    table: Table | null;
    justCreated: boolean;
}

/**
 * Returns the doc_chunks table. Mirrors `getCodeChunksTable`: pass a seed
 * row when about to write so the table can be created on first use; pass
 * `null` for read-only callers and handle `table === null`. Shares the
 * module-level `mutex` chain so writes to both tables are serialized
 * within a single process.
 */
export async function getDocChunksTable(seedRow: DocChunkRow | null): Promise<GetDocChunksTableResult> {
    if (docChunksTableCache) {
        return { table: docChunksTableCache, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetDocChunksTableResult> => {
        if (docChunksTableCache) {
            return { table: docChunksTableCache, justCreated: false };
        }

        const db = await getDocsDb();
        const tableNames = await db.tableNames();

        if (tableNames.includes(DOC_CHUNKS_TABLE)) {
            docChunksTableCache = await db.openTable(DOC_CHUNKS_TABLE);
            void ensureContentFtsIndex(docChunksTableCache, DOC_FTS_KEY, docFtsEnsuredKeys);

            return { table: docChunksTableCache, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        docChunksTableCache = await db.createTable(
            DOC_CHUNKS_TABLE,
            [seedRow as unknown as Record<string, unknown>],
        );
        void ensureContentFtsIndex(docChunksTableCache, DOC_FTS_KEY, docFtsEnsuredKeys);

        return { table: docChunksTableCache, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

/**
 * Total number of doc chunks currently stored. Returns 0 if the table has
 * never been created.
 */
export async function countDocChunks(): Promise<number> {
    const { table } = await getDocChunksTable(null);

    if (!table) return 0;

    try {
        return await table.countRows();
    } catch {
        return 0;
    }
}



