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

const MEMORY_TABLE = 'memory';

let dbCache: Connection | null = null;
let memoryTableCache: Table | null = null;
let codeChunksTableCache: Table | null = null;

const CODE_CHUNKS_TABLE = 'code_chunks';

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

    return dbCache;
}

/**
 * Returns the memory table along with whether this call had to create it
 * (in which case `seedRow` was already inserted as the first row).
 * Pass `seedRow` whenever you are about to perform a write; pass `null` for
 * read-only operations and handle the `table === null` result.
 */
let mutex: Promise<unknown> = Promise.resolve();

export interface GetMemoryTableResult {
    table: Table | null;
    justCreated: boolean;
}

export async function getMemoryTable(seedRow: MemoryRow | null): Promise<GetMemoryTableResult> {
    if (memoryTableCache) {
        return { table: memoryTableCache, justCreated: false };
    }

    const next = mutex.then(async (): Promise<GetMemoryTableResult> => {
        if (memoryTableCache) {
            return { table: memoryTableCache, justCreated: false };
        }

        const db = await getDb();
        const tableNames = await db.tableNames();

        if (tableNames.includes(MEMORY_TABLE)) {
            memoryTableCache = await db.openTable(MEMORY_TABLE);

            return { table: memoryTableCache, justCreated: false };
        }

        if (!seedRow) {
            return { table: null, justCreated: false };
        }

        memoryTableCache = await db.createTable(MEMORY_TABLE, [seedRow as unknown as Record<string, unknown>]);

        return { table: memoryTableCache, justCreated: true };
    });

    mutex = next.catch(() => undefined);

    return next;
}

/**
 * Test-only reset of the in-process cache. Not exported via index.
 */
export function _resetCachesForTest(): void {
    dbCache = null;
    memoryTableCache = null;
    codeChunksTableCache = null;
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
