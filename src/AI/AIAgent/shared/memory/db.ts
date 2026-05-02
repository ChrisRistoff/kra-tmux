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
import type { CodeChunkRow, MemoryRow } from './types';
import type { DocChunkRow } from '../docs/types';
import { _resetRepoStorageCacheForTest, resolveRepoStorage } from './repoKey';
import { kraDocsLanceRoot, kraDocsRoot } from '@/filePaths';

const MEMORY_FINDINGS_TABLE = 'memory_findings';
const MEMORY_REVISITS_TABLE = 'memory_revisits';

let dbCache: Connection | null = null;
let docsDbCache: Connection | null = null;
let memoryFindingsTableCache: Table | null = null;
let memoryRevisitsTableCache: Table | null = null;
let codeChunksTableCache: Table | null = null;
let docChunksTableCache: Table | null = null;

const CODE_CHUNKS_TABLE = 'code_chunks';
const DOC_CHUNKS_TABLE = 'doc_chunks';
const LEGACY_MEMORY_TABLE = 'memory';
let legacyDropAttempted = false;

async function memoryRoot(): Promise<string> {
    const info = await resolveRepoStorage();

    return info.repoStorageDir;
}

async function lanceRoot(): Promise<string> {
    return path.join(await memoryRoot(), 'lance');
}

async function getDb(): Promise<Connection> {
    if (dbCache) {
        return dbCache;
    }

    dbCache = await connect(await lanceRoot());
    if (!legacyDropAttempted) {
        legacyDropAttempted = true;
        try {
            const names = await dbCache.tableNames();
            if (names.includes(LEGACY_MEMORY_TABLE)) {
                await dbCache.dropTable(LEGACY_MEMORY_TABLE);
            }
        } catch {
            // best-effort cleanup; ignore failures
        }
    }

    return dbCache;
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
    cacheGet: () => Table | null,
    cacheSet: (t: Table) => void,
    seedRow: MemoryRow | null,
): Promise<GetMemoryTableResult> {
    const cached = cacheGet();
    if (cached) {
        return { table: cached, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetMemoryTableResult> => {
        const c = cacheGet();
        if (c) {
            return { table: c, justCreated: false };
        }

        const db = await getDb();
        const tableNames = await db.tableNames();

        if (tableNames.includes(tableName)) {
            const t = await db.openTable(tableName);
            cacheSet(t);

            return { table: t, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        const t = await db.createTable(tableName, [seedRow as unknown as Record<string, unknown>]);
        cacheSet(t);

        return { table: t, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

export async function getFindingsTable(seedRow: MemoryRow | null): Promise<GetMemoryTableResult> {
    return getOrCreateMemoryTable(
        MEMORY_FINDINGS_TABLE,
        () => memoryFindingsTableCache,
        (t) => { memoryFindingsTableCache = t; },
        seedRow,
    );
}

export async function getRevisitsTable(seedRow: MemoryRow | null): Promise<GetMemoryTableResult> {
    return getOrCreateMemoryTable(
        MEMORY_REVISITS_TABLE,
        () => memoryRevisitsTableCache,
        (t) => { memoryRevisitsTableCache = t; },
        seedRow,
    );
}

/**
 * Test-only reset of the in-process cache. Not exported via index.
 */
export function _resetCachesForTest(): void {
    dbCache = null;
    docsDbCache = null;
    memoryFindingsTableCache = null;
    memoryRevisitsTableCache = null;
    codeChunksTableCache = null;
    docChunksTableCache = null;
    legacyDropAttempted = false;
    _resetRepoStorageCacheForTest();
}

/**
 * Returns the central per-repo storage root used by the kra-memory layer
 * (`~/.kra/.kra-memory/repos/<repoKey>/`). The repo identity is resolved
 * from `WORKING_DIR` (set by the parent process when the MCP server is
 * spawned) or `process.cwd()` for direct calls.
 */
export async function memoryDirectoryRoot(): Promise<string> {
    return memoryRoot();
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
export async function getCodeChunksTable(seedRow: CodeChunkRow | null): Promise<GetCodeChunksTableResult> {
    if (codeChunksTableCache) {
        return { table: codeChunksTableCache, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetCodeChunksTableResult> => {
        if (codeChunksTableCache) {
            return { table: codeChunksTableCache, justCreated: false };
        }

        const db = await getDb();
        const tableNames = await db.tableNames();

        if (tableNames.includes(CODE_CHUNKS_TABLE)) {
            codeChunksTableCache = await db.openTable(CODE_CHUNKS_TABLE);

            return { table: codeChunksTableCache, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        codeChunksTableCache = await db.createTable(
            CODE_CHUNKS_TABLE,
            [seedRow as unknown as Record<string, unknown>],
        );

        return { table: codeChunksTableCache, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

/**
 * Total number of code chunks currently stored. Returns 0 if the table has
 * never been created.
 */
export async function countCodeChunks(): Promise<number> {
    const { table } = await getCodeChunksTable(null);

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

            return { table: docChunksTableCache, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        docChunksTableCache = await db.createTable(
            DOC_CHUNKS_TABLE,
            [seedRow as unknown as Record<string, unknown>],
        );

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
