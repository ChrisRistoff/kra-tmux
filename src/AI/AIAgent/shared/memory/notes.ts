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
import { getMemoryTable } from './db';
import {
    decodeRow,
    type MemoryEntryWithScore,
    type MemoryRow,
    type RecallInput,
    type RememberInput,
    type UpdateMemoryInput,
} from './types';

const DEFAULT_RECALL_K = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_BODY_FETCH = 1000;

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

export async function remember(input: RememberInput): Promise<{ id: string }> {
    if (!input.title || !input.body) {
        throw new Error('remember: title and body are required');
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
        status: input.kind === 'revisit' ? 'open' : 'resolved',
        resolution: '',
        createdAt: now,
        source: input.source ?? 'agent-auto',
    });

    const { table, justCreated } = await getMemoryTable(row);

    if (!table) {
        throw new Error('remember: failed to obtain memory table');
    }

    // When justCreated is true, `row` was already inserted as the seed row
    // during createTable; a second add() would duplicate it.
    if (!justCreated) {
        await table.add([row as unknown as Record<string, unknown>]);
    }

    return { id: row.id };
}

export async function recall(input: RecallInput): Promise<MemoryEntryWithScore[]> {
    const { table } = await getMemoryTable(null);

    if (!table) {
        return [];
    }

    const k = Math.max(1, Math.min(input.k ?? DEFAULT_RECALL_K, 200));
    const tagFilter = sanitizeStringList(input.tagsAny);
    const query = input.query?.trim() ?? '';

    const matchesFilters = (row: MemoryRow): boolean => {
        if (input.kind && row.kind !== input.kind) {
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


export async function updateMemory(input: UpdateMemoryInput): Promise<{ ok: true }> {
    if (!input.id) {
        throw new Error('update_memory: id is required');
    }

    // Defensive runtime check: MCP arguments arrive untyped
    const status = input.status as string;

    if (status !== 'resolved' && status !== 'dismissed') {
        throw new Error(`update_memory: status must be 'resolved' or 'dismissed', got '${status}'`);
    }

    const { table } = await getMemoryTable(null);

    if (!table) {
        throw new Error('update_memory: memory table does not exist yet');
    }

    const safeId = input.id.replace(/'/g, "''");
    const updateValues: Record<string, string | number> = {
        status: input.status,
        updatedAt: Date.now(),
    };

    if (input.resolution !== undefined) {
        updateValues['resolution'] = input.resolution;
    }

    await table.update({
        values: updateValues,
        where: `id = '${safeId}'`,
    });

    return { ok: true };
}

export async function deleteMemory(id: string): Promise<{ ok: true }> {
    if (!id) {
        throw new Error('delete_memory: id is required');
    }

    const { table } = await getMemoryTable(null);

    if (!table) {
        throw new Error('delete_memory: memory table does not exist yet');
    }

    const safeId = id.replace(/'/g, "''");
    await table.delete(`id = '${safeId}'`);

    return { ok: true };
}
