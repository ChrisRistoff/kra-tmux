/**
 * Vector search across the kra-memory code_chunks (and optionally memory)
 * tables. Results are scored by cosine similarity (LanceDB default for
 * BGE-small) and merged across collections when `scope === 'both'`.
 */

import { embedOne } from './embedder';
import { getCodeChunksTable, getFindingsTable, getRevisitsTable } from './db';
import { matchGlob } from './indexer';
import {
    decodeRow,
    isRevisitKind,
    type CodeChunkRow,
    type MemoryKind,
    type MemoryRow,
    type SemanticSearchHit,
    type SemanticSearchInput,
} from './types';

export async function semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchHit[]> {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error('semanticSearch: query is required and must be non-empty');
    }
    const k = clamp(input.k ?? 10, 1, 100);
    const scope = input.scope ?? 'code';
    const queryVector = await embedOne(input.query);
    const hits: SemanticSearchHit[] = [];

    if (scope === 'code' || scope === 'both') {
        hits.push(...await searchCode(queryVector, k, input.pathGlob));
    }

    if (scope === 'memory' || scope === 'both') {
        if (!input.memoryKind) {
            throw new Error("semanticSearch: 'memoryKind' is required when scope includes 'memory'");
        }

        hits.push(...await searchMemory(queryVector, k, input.memoryKind));
    }

    hits.sort((a, b) => b.score - a.score);

    return hits.slice(0, k);
}

async function searchCode(vector: number[], k: number, pathGlob?: string): Promise<SemanticSearchHit[]> {
    const { table } = await getCodeChunksTable(null);

    if (!table) return [];

    // Pull a wider net when filtering by glob so post-filter still yields k hits.
    const fetchK = pathGlob ? Math.min(k * 5, 200) : k;
    const rows = await table.search(vector).limit(fetchK).toArray();

    return rows
        .map(toCodeHit)
        .filter((hit) => !pathGlob || (hit.code ? matchGlob(hit.code.path, pathGlob) : false))
        .slice(0, k);
}

async function searchMemory(vector: number[], k: number, kind: MemoryKind): Promise<SemanticSearchHit[]> {
    const getter = isRevisitKind(kind) ? getRevisitsTable : getFindingsTable;
    const { table } = await getter(null);

    if (!table) return [];

    // Findings table holds multiple kinds; filter to the requested one.
    // Revisits table only has 'revisit' rows so the filter is a no-op there.
    const fetchK = Math.min(k * 4, 200);
    const rows = await table.search(vector).limit(fetchK).toArray();

    return rows
        .map(toMemoryHit)
        .filter((hit) => hit.memory?.kind === kind)
        .slice(0, k);
}

function toCodeHit(raw: Record<string, unknown>): SemanticSearchHit {
    const row = raw as unknown as CodeChunkRow & { _distance?: number };
    const score = distanceToScore(row._distance);

    return {
        type: 'code',
        score,
        code: {
            id: row.id,
            path: row.path,
            startLine: row.startLine,
            endLine: row.endLine,
            symbol: row.symbol === '' ? null : row.symbol,
            language: row.language,
            snippet: row.content,
            score,
        },
    };
}

function toMemoryHit(raw: Record<string, unknown>): SemanticSearchHit {
    const row = raw as unknown as MemoryRow & { _distance?: number };
    const score = distanceToScore(row._distance);

    return {
        type: 'memory',
        score,
        memory: decodeRow(row),
    };
}

function distanceToScore(distance: number | undefined): number {
    if (typeof distance !== 'number' || !Number.isFinite(distance)) return 0;

    // LanceDB returns L2 distance by default for BGE vectors. Convert to a
    // similarity in [0, 1] by mapping with 1 / (1 + d). It's monotonic so the
    // sort order is preserved and consumers get a friendlier score.
    return 1 / (1 + distance);
}

function clamp(n: number, min: number, max: number): number {
    if (n < min) return min;
    if (n > max) return max;

    return n;
}
