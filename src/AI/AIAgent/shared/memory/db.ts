/**
 * LanceDB connection for the kra-memory layer.
 *
 * Storage layout:
 *   <repo>/.kra-memory/lance/        ← LanceDB datasets (one dir per table)
 *
 * `<repo>` is resolved from `WORKING_DIR` (set by the spawning provider when
 * the MCP server is launched as a child process) or `process.cwd()` for direct
 * tests.
 *
 * The `memory` table is created lazily on the first write. We do this rather
 * than declaring an Arrow schema up front so we can rely on LanceDB's
 * row-based schema inference and keep the table-management code small.
 */

import path from 'path';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { CodeChunkRow, MemoryRow } from './types';

const MEMORY_FINDINGS_TABLE = 'memory_findings';
const MEMORY_REVISITS_TABLE = 'memory_revisits';

let dbCache: Connection | null = null;
let memoryFindingsTableCache: Table | null = null;
let memoryRevisitsTableCache: Table | null = null;
let codeChunksTableCache: Table | null = null;

const CODE_CHUNKS_TABLE = 'code_chunks';
const LEGACY_MEMORY_TABLE = 'memory';
let legacyDropAttempted = false;

function memoryRoot(): string {
    const cwd = process.env['WORKING_DIR'] ?? process.cwd();

    return path.join(cwd, '.kra-memory');
}

function lanceRoot(): string {
    return path.join(memoryRoot(), 'lance');
}

async function getDb(): Promise<Connection> {
    if (dbCache) {
        return dbCache;
    }

    dbCache = await connect(lanceRoot());

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
    memoryFindingsTableCache = null;
    memoryRevisitsTableCache = null;
    codeChunksTableCache = null;
    legacyDropAttempted = false;
}

/**
 * Returns the LanceDB root directory used by the memory layer.
 * Resolved relative to `WORKING_DIR` (set by the parent process when the MCP
 * server is spawned) or `process.cwd()` for direct calls.
 */
export function memoryDirectoryRoot(): string {
    return memoryRoot();
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
