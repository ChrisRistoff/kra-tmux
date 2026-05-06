/**
 * Memory operations exposed via the kra-memory MCP server.
 *
 * The public surface is intentionally tiny:
 *   - remember         add a memory entry (any kind, including 'revisit')
 *   - recall           vector search OR list mode (when query is omitted)
 *   - updateMemory     mark an entry resolved / dismissed (optionally with a resolution note)
 */

import crypto from 'crypto';
import { embedOne } from './embedder';
import { getFindingsTable, getRevisitsTable } from './db';
import {
    decodeRow,
    isFindingKind,
    isMemoryLookupKind,
    isRevisitKind,
    MEMORY_LOOKUP_KINDS,
    type EditMemoryInput,
    type MemoryEntryWithScore,
    type MemoryKind,
    type MemoryLookupKind,
    type MemoryRow,
    type RecallInput,
    type RememberInput,
    type UpdateMemoryInput,
} from './types';

const DEFAULT_RECALL_K = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_BODY_FETCH = 1000;

function getMultiRepoSearchKeys(): string[] {
    const env = process.env['KRA_SEARCH_REPO_KEYS'];
    if (typeof env !== 'string' || env.trim().length === 0) return [];

    return env.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function newId(): string {
    return crypto.randomBytes(8).toString('hex');
}

function sanitizeStringList(input: unknown): string[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const seen = new Set<string>();

    for (const item of input) {
        if (typeof item === 'string' && item.length > 0) {
            seen.add(item);
        }
    }

    return [...seen];
}

function embedTextFor(title: string, body: string): string {
    return `${title}\n\n${body}`.trim();
}

async function buildRow(
    base: Omit<MemoryRow, 'vector' | 'updatedAt'> & { updatedAt?: number },
): Promise<MemoryRow> {
    const vector = await embedOne(embedTextFor(base.title, base.body));

    return {
        ...base,
        updatedAt: base.updatedAt ?? base.createdAt,
        vector,
    };
}

type TableGetter = (seed: MemoryRow | null, repoKey?: string) => Promise<{ table: import('@lancedb/lancedb').Table | null; justCreated: boolean }>;

function pickTableGetter(kind: MemoryKind): TableGetter {
    return isRevisitKind(kind) ? getRevisitsTable : getFindingsTable;
}

function pickReadTableGetter(kind: MemoryLookupKind): TableGetter {
    return kind === 'findings' || isFindingKind(kind) ? getFindingsTable : getRevisitsTable;
}

export async function remember(input: RememberInput & { repoKey?: string }): Promise<{ id: string }> {
    if (!input.title || !input.body) {
        throw new Error('remember: title and body are required');
    }

    if (!isFindingKind(input.kind) && !isRevisitKind(input.kind)) {
        throw new Error(`remember: unknown kind '${input.kind}'`);
    }

    const now = Date.now();
    const row = await buildRow({
        id: newId(),
        kind: input.kind,
        title: input.title.trim(),
        body: input.body.trim(),
        tags: JSON.stringify(sanitizeStringList(input.tags)),
        paths: JSON.stringify(sanitizeStringList(input.paths)),
        branch: input.branch ?? '',
        status: isRevisitKind(input.kind) ? 'open' : 'resolved',
        resolution: '',
        createdAt: now,
        source: input.source ?? 'agent-auto',
    });

    const getter = pickTableGetter(input.kind);
    const { table, justCreated } = await getter(row, input.repoKey);

    if (!table) {
        throw new Error('remember: failed to obtain memory table');
    }

    if (!justCreated) {
        await table.add([row as unknown as Record<string, unknown>]);
    }

    return { id: row.id };
}

async function readFromTable(
    table: import('@lancedb/lancedb').Table,
    input: { query?: string; k?: number; tagsAny?: string[]; selectedIds?: string[]; status?: MemoryEntryWithScore['status']; kind?: MemoryLookupKind },
): Promise<MemoryEntryWithScore[]> {
    const k = Math.max(1, Math.min(input.k ?? DEFAULT_RECALL_K, 200));
    const tagFilter = sanitizeStringList(input.tagsAny);
    const selectedIdSet = input.selectedIds !== undefined ? new Set(sanitizeStringList(input.selectedIds)) : undefined;
    const query = input.query?.trim() ?? '';

    const matchesFilters = (row: MemoryRow): boolean => {
        if (input.kind && input.kind !== 'findings' && row.kind !== input.kind) {
            return false;
        }

        if (selectedIdSet !== undefined && !selectedIdSet.has(row.id)) {
            return false;
        }

        if (input.status && row.status !== input.status) {
            return false;
        }

        if (tagFilter.length > 0) {
            const decoded = decodeRow(row);

            if (!tagFilter.some((t) => decoded.tags.includes(t))) {
                return false;
            }
        }

        return true;
    };

    if (query.length === 0) {
        const total = await table.countRows();

        if (total === 0) {
            return [];
        }

        const fetchLimit = Math.min(total, MAX_BODY_FETCH);
        const raw = await table.query().limit(fetchLimit).toArray();
        const out: MemoryEntryWithScore[] = [];

        for (const r of raw) {
            const row = r as MemoryRow;

            if (!matchesFilters(row)) {
                continue;
            }

            out.push({ ...decodeRow(row), score: 0 });
        }

        out.sort((a, b) => b.createdAt - a.createdAt);

        const limit = Math.min(input.k ?? DEFAULT_LIST_LIMIT, k);

        return out.slice(0, limit);
    }

    const queryVector = await embedOne(query);
    const fetchK = Math.min(k * 4, MAX_BODY_FETCH);
    const raw = await table.search(queryVector).limit(fetchK).toArray();
    const out: MemoryEntryWithScore[] = [];
    for (const r of raw) {
        const row = r as MemoryRow & { _distance: number };

        if (!matchesFilters(row)) {
            continue;
        }

        out.push({ ...decodeRow(row), score: 1 - row._distance });

        if (out.length >= k) {
            break;
        }
    }

    return out;
}

export async function recall(input: RecallInput & { repoKey?: string }): Promise<MemoryEntryWithScore[]> {
    if (!isMemoryLookupKind(input.kind)) {
        throw new Error(`recall: 'kind' is required and must be one of: ${MEMORY_LOOKUP_KINDS.join(', ')}`);
    }

    const getter = pickReadTableGetter(input.kind);
    const { table } = await getter(null, input.repoKey);

    if (!table) {
        return [];
    }

    const subInput: { kind: MemoryLookupKind; query?: string; k?: number; selectedIds?: string[]; tagsAny?: string[]; status?: MemoryEntryWithScore['status'] } = {
        kind: input.kind,
    };
    if (input.query !== undefined) {
        subInput.query = input.query;
    }
    if (input.k !== undefined) {
        subInput.k = input.k;
    }
    if (input.selectedIds !== undefined) {
        subInput.selectedIds = input.selectedIds;
    }
    if (input.tagsAny !== undefined) {
        subInput.tagsAny = input.tagsAny;
    }
    if (input.status !== undefined) {
        subInput.status = input.status;
    }

    return readFromTable(table, subInput);
}

/**
 * Multi-repo recall: invoke `recall` once per advertised repoKey and merge
 * the result lists, sorted by descending score (or createdAt when no query).
 * Default `repoKeys` come from `KRA_SEARCH_REPO_KEYS` (which the agent layer
 * sets from the user's repo selection); pass an explicit list to override.
 */
export async function recallMulti(
    input: RecallInput,
    repoKeys?: string[],
): Promise<MemoryEntryWithScore[]> {
    const keys = (repoKeys && repoKeys.length > 0) ? repoKeys : getMultiRepoSearchKeys();
    if (keys.length === 0) {
        return recall(input);
    }

    const k = Math.max(1, Math.min(input.k ?? DEFAULT_RECALL_K, 200));
    const perRepo = await Promise.all(keys.map(async (repoKey) => recall({ ...input, repoKey })));
    const merged = perRepo.flat();

    if (input.query !== undefined && input.query.trim().length > 0) {
        merged.sort((a, b) => b.score - a.score);
    } else {
        merged.sort((a, b) => b.createdAt - a.createdAt);
    }

    return merged.slice(0, k);
}

/**
 * UI-oriented listing that returns entries from one or both memory tables
 * without requiring a single specific MemoryKind. Always list mode (no vector
 * search). Sorted newest-first across the merged result set.
 */
export async function listMemories(input: {
    scope: 'all' | 'findings' | 'revisits';
    limit?: number;
    tagsAny?: string[];
    repoKey?: string;
}): Promise<MemoryEntryWithScore[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, MAX_BODY_FETCH));
    const out: MemoryEntryWithScore[] = [];

    const fetchOne = async (
        getter: TableGetter,
    ): Promise<void> => {
        const { table } = await getter(null, input.repoKey);
        if (!table) {
            return;
        }
        const subInput: { k: number; tagsAny?: string[] } = { k: limit };
        if (input.tagsAny !== undefined) {
            subInput.tagsAny = input.tagsAny;
        }
        const part = await readFromTable(table, subInput);
        out.push(...part);
    };

    if (input.scope === 'findings' || input.scope === 'all') {
        await fetchOne(getFindingsTable);
    }
    if (input.scope === 'revisits' || input.scope === 'all') {
        await fetchOne(getRevisitsTable);
    }

    out.sort((a, b) => b.createdAt - a.createdAt);

    return out.slice(0, limit);
}

export async function updateMemory(input: UpdateMemoryInput & { repoKey?: string }): Promise<{ ok: true }> {
    if (!input.id) {
        throw new Error('update_memory: id is required');
    }

    const status = input.status as string;

    if (status !== 'open' && status !== 'resolved' && status !== 'dismissed') {
        throw new Error(`update_memory: status must be 'open', 'resolved' or 'dismissed', got '${status}'`);
    }

    const located = await findRowAcrossTables(input.id, input.repoKey);
    if (!located) {
        throw new Error(`update_memory: id '${input.id}' not found in any selected repo`);
    }
    const { table } = located;

    const safeId = input.id.replace(/'/g, "''");
    const updateValues: Record<string, string | number> = {
        status: input.status,
        updatedAt: Date.now(),
    };

    if (status === 'open') {
        // Reopening clears any prior resolution note so the entry is back to a
        // pristine "awaiting human input" state.
        updateValues['resolution'] = '';
    } else if (input.resolution !== undefined) {
        updateValues['resolution'] = input.resolution;
    }

    await table.update({
        values: updateValues,
        where: `id = '${safeId}'`,
    });

    return { ok: true };
}

async function findRowAcrossTables(
    id: string,
    repoKey?: string,
): Promise<{ table: import('@lancedb/lancedb').Table; row: MemoryRow } | null> {
    const safeId = id.replace(/'/g, "''");
    const tryGetter = async (
        getter: TableGetter,
        keyForRepo?: string,
    ): Promise<{ table: import('@lancedb/lancedb').Table; row: MemoryRow } | null> => {
        const { table } = await getter(null, keyForRepo);
        if (!table) {
            return null;
        }
        const found = await table.query().where(`id = '${safeId}'`).limit(1).toArray();
        if (found.length === 0) {
            return null;
        }

        return { table, row: found[0] as MemoryRow };
    };

    if (repoKey) {
        return (await tryGetter(getRevisitsTable, repoKey))
            ?? (await tryGetter(getFindingsTable, repoKey));
    }

    // No explicit repo: walk every selected repo (KRA_SELECTED_REPO_ROOTS).
    // Falls through to the primary repo when no multi-repo set is advertised.
    const repoKeys = getMultiRepoSearchKeys();
    if (repoKeys.length === 0) {
        return (await tryGetter(getRevisitsTable))
            ?? (await tryGetter(getFindingsTable));
    }
    for (const key of repoKeys) {
        const hit = (await tryGetter(getRevisitsTable, key))
            ?? (await tryGetter(getFindingsTable, key));
        if (hit) return hit;
    }

    return null;
}

export async function deleteMemory(id: string, repoKey?: string): Promise<{ ok: true }> {
    if (!id) {
        throw new Error('delete_memory: id is required');
    }

    if (!repoKey) {
        const located = await findRowAcrossTables(id);
        if (located) {
            await located.table.delete(`id = '${id.replace(/'/g, "''")}'`);
        }

        return { ok: true };
    }

    const safeId = id.replace(/'/g, "''");
    const where = `id = '${safeId}'`;

    const { table: revisitsTable } = await getRevisitsTable(null, repoKey);
    if (revisitsTable) {
        await revisitsTable.delete(where);
    }

    const { table: findingsTable } = await getFindingsTable(null, repoKey);
    if (findingsTable) {
        await findingsTable.delete(where);
    }

    return { ok: true };
}

export async function editMemory(input: EditMemoryInput & { repoKey?: string }): Promise<{ ok: true }> {
    if (!input.id) {
        throw new Error('edit_memory: id is required');
    }

    const located = await findRowAcrossTables(input.id, input.repoKey);
    if (!located) {
        throw new Error(`edit_memory: no entry found for id '${input.id}'`);
    }

    const { table, row } = located;
    const safeId = input.id.replace(/'/g, "''");

    const newTitle = input.title !== undefined ? input.title.trim() : row.title;
    const newBody = input.body !== undefined ? input.body.trim() : row.body;
    const newTags = input.tags !== undefined ? JSON.stringify(sanitizeStringList(input.tags)) : row.tags;
    const newPaths = input.paths !== undefined ? JSON.stringify(sanitizeStringList(input.paths)) : row.paths;
    const newBranch = input.branch !== undefined ? (input.branch ?? '') : row.branch;

    const updateValues: Record<string, string | number | number[]> = {
        title: newTitle,
        body: newBody,
        tags: newTags,
        paths: newPaths,
        branch: newBranch,
        updatedAt: Date.now(),
    };

    if (input.title !== undefined || input.body !== undefined) {
        updateValues['vector'] = await embedOne(embedTextFor(newTitle, newBody));
    }

    await table.update({
        values: updateValues,
        where: `id = '${safeId}'`,
    });

    return { ok: true };
}

