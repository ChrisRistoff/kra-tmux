/**
 * Vector search across the kra-memory code_chunks (and optionally memory)
 * tables. Code hits are aggregated per file: one entry per matched path with
 * merged matched line ranges (parallel `startLines` / `endLines` arrays
 * matching the read_lines tool shape) so the agent knows where to look
 * without us shipping any source code in the response.
 */
import { embedOne } from './embedder';
import { getCodeChunksTable, getFindingsTable, getRevisitsTable } from './db';
import { matchGlob } from './indexer';
import {
    decodeRow,
    isRevisitKind,
    type CodeChunkRow,
    type CodeFileHitData,
    type MemoryKind,
    type MemoryRow,
    type SemanticSearchHit,
    type SemanticSearchInput,
} from './types';

interface RawCodeChunkHit {
    path: string;
    language: string;
    startLine: number;
    endLine: number;
    score: number;
}

// Drop low-confidence semantic hits before returning to the caller. Anything
// below this score is noise in practice and just bloats the agent's context.
const MIN_SCORE = 0.55;

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

    const filtered = hits.filter((h) => h.score >= MIN_SCORE);
    filtered.sort((a, b) => b.score - a.score);

    return filtered.slice(0, k);
}

async function searchCode(vector: number[], k: number, pathGlob?: string): Promise<SemanticSearchHit[]> {
    const { table } = await getCodeChunksTable(null);

    if (!table) return [];

    // Pull a wide net so deduping by path still leaves us with k distinct files.
    // Files commonly own multiple matching chunks; an unfiltered fetch of `k`
    // would routinely yield <k unique paths after grouping.
    const fetchK = Math.min(Math.max(k * 8, 40), 400);
    const rows = await table.search(vector).limit(fetchK).toArray();

    const rawHits: RawCodeChunkHit[] = rows
        .map(toRawCodeHit)
        .filter((hit) => !pathGlob || matchGlob(hit.path, pathGlob));

    const grouped = groupByPath(rawHits);
    const topPaths = [...grouped.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

    return Promise.all(topPaths.map(async (group) => {
        const merged = mergeRanges(group.ranges);
        const code: CodeFileHitData = {
            path: group.path,
            language: group.language,
            lineCount: 0,
            startLines: merged.map((r) => r.start),
            endLines: merged.map((r) => r.end),
        };

        return { type: 'code', score: group.score, code } satisfies SemanticSearchHit;
    }));
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

function toRawCodeHit(raw: Record<string, unknown>): RawCodeChunkHit {
    const row = raw as unknown as CodeChunkRow & { _distance?: number };

    return {
        path: row.path,
        language: row.language,
        startLine: row.startLine,
        endLine: row.endLine,
        score: distanceToScore(row._distance),
    };
}

interface PathGroup {
    path: string;
    language: string;
    score: number;
    ranges: { start: number; end: number }[];
}

function groupByPath(hits: RawCodeChunkHit[]): Map<string, PathGroup> {
    const groups = new Map<string, PathGroup>();
    for (const hit of hits) {
        const existing = groups.get(hit.path);
        if (existing) {
            existing.ranges.push({ start: hit.startLine, end: hit.endLine });
            if (hit.score > existing.score) existing.score = hit.score;
        } else {
            groups.set(hit.path, {
                path: hit.path,
                language: hit.language,
                score: hit.score,
                ranges: [{ start: hit.startLine, end: hit.endLine }],
            });
        }
    }

    return groups;
}

function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const out: { start: number; end: number }[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const tail = out[out.length - 1];
        if (cur.start <= tail.end + 1) {
            if (cur.end > tail.end) tail.end = cur.end;
        } else {
            out.push({ ...cur });
        }
    }

    return out;
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
