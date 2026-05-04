/**
 * Vector search across the kra-memory code_chunks (and optionally memory)
 * tables. Code hits are aggregated per file: one entry per matched path with
 * merged matched line ranges (parallel `startLines` / `endLines` arrays
 * matching the read_lines tool shape) so the agent knows where to look
 * without us shipping any source code in the response.
 */
import path from 'path';
import { embedOne } from './embedder';
import { getCodeChunksTable, getFindingsTable, getRevisitsTable } from './db';
import { hybridSearch, distanceToScore } from './hybridSearch';
import { matchGlob } from './indexer';
import { getActiveSearchRepoKeys } from './groups';
import { loadRegistry, type RegistryEntry } from './registry';
import { resolveRepoStorage } from './repoKey';
import {
    decodeRow,
    isFindingKind,
    isMemoryLookupKind,
    MEMORY_LOOKUP_KINDS,
    type CodeChunkRow,
    type CodeFileHitData,
    type MemoryLookupKind,
    type MemoryRow,
    type SemanticSearchHit,
    type SemanticSearchInput,
} from './types';

interface RawCodeChunkHit {
    id: string;
    path: string;
    language: string;
    startLine: number;
    endLine: number;
    score: number;
    repoKey: string;
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
        hits.push(...await searchCode(input.query, queryVector, k, input.pathGlob));
    }

    if (scope === 'memory' || scope === 'both') {
        if (!input.memoryKind || !isMemoryLookupKind(input.memoryKind)) {
            throw new Error(`semanticSearch: 'memoryKind' is required when scope includes 'memory' and must be one of: ${MEMORY_LOOKUP_KINDS.join(', ')}`);
        }

        hits.push(...await searchMemory(queryVector, k, input.memoryKind, input.selectedIds));
    }

    // Code hits are pre-filtered inside searchCode (vector-only candidates
    // already had MIN_SCORE applied; FTS-only hits bypass the threshold by
    // design). Memory hits still use the cosine threshold here.
    const filtered = hits.filter((h) => h.type === 'code' || h.score >= MIN_SCORE);
    filtered.sort((a, b) => b.score - a.score);

    return filtered.slice(0, k);
}

async function searchCode(query: string, vector: number[], k: number, pathGlob?: string): Promise<SemanticSearchHit[]> {
    const repoKeys = await resolveRepoSearchSet();
    if (repoKeys.length === 0) return [];

    const multiRepo = repoKeys.length > 1;
    const registry = multiRepo ? await loadRegistry() : null;
    const repoMeta: Map<string, RegistryEntry | undefined> = new Map();
    if (registry) {
        for (const entry of Object.values(registry.repos)) {
            repoMeta.set(entry.repoKey, entry);
        }
    }

    // Pull a wide net so deduping by path still leaves us with k distinct files.
    // Files commonly own multiple matching chunks; an unfiltered fetch of `k`
    // would routinely yield <k unique paths after grouping.
    const fetchK = Math.min(Math.max(k * 8, 40), 400);

    const perRepoHits = await Promise.all(repoKeys.map(async (repoKey): Promise<RawCodeChunkHit[]> => {
        const { table } = await getCodeChunksTable(null, repoKey);
        if (!table) return [];

        const fused = await hybridSearch(table, query, vector, {
            fetchK,
            minVectorScore: MIN_SCORE,
        });

        return fused.map((hit): RawCodeChunkHit => {
            const row = hit.row as unknown as CodeChunkRow;

            return {
                id: String((hit.row as { id?: unknown }).id ?? ''),
                path: row.path,
                language: row.language,
                startLine: row.startLine,
                endLine: row.endLine,
                score: hit.score,
                repoKey,
            };
        });
    }));

    const rawHits: RawCodeChunkHit[] = perRepoHits.flat()
        .filter((hit) => !pathGlob || matchGlob(hit.path, pathGlob));

    const grouped = groupByPath(rawHits);
    const topPaths = [...grouped.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

    // Normalize RRF scores to [0, 1] so they're comparable to the cosine
    // scores returned by searchMemory when scope='both'. RRF values are tiny
    // (~0.03 max) and would otherwise always sort below memory hits.
    const maxScore = topPaths.reduce((m, g) => Math.max(m, g.score), 0);
    const norm = maxScore > 0 ? 1 / maxScore : 1;

    return Promise.all(topPaths.map(async (group) => {
        const merged = mergeRanges(group.ranges);
        const meta = repoMeta.get(group.repoKey);
        const absolutePath = multiRepo && meta?.rootPath
            ? path.isAbsolute(group.path) ? group.path : path.join(meta.rootPath, group.path)
            : group.path;
        const code: CodeFileHitData = {
            path: absolutePath,
            language: group.language,
            lineCount: 0,
            startLines: merged.map((r) => r.start),
            endLines: merged.map((r) => r.end),
            ...(multiRepo && meta ? { repo: meta.alias, rootPath: meta.rootPath } : {}),
        };

        return { type: 'code', score: group.score * norm, code } satisfies SemanticSearchHit;
    }));
}


async function resolveRepoSearchSet(): Promise<string[]> {
    const active = await getActiveSearchRepoKeys();
    if (active.length > 0) return active;

    // Default: just the current repo (preserves single-repo behavior).
    try {
        const info = await resolveRepoStorage();

        return [info.repoKey];
    } catch {
        return [];
    }
}

async function searchMemory(vector: number[], k: number, kind: MemoryLookupKind, selectedIds?: string[]): Promise<SemanticSearchHit[]> {
    const getter = kind === 'findings' || isFindingKind(kind) ? getFindingsTable : getRevisitsTable;
    const { table } = await getter(null);

    if (!table) return [];

    const selectedIdSet = selectedIds !== undefined ? new Set(selectedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)) : undefined;

    const fetchK = Math.min(k * 4, 200);
    const rows = await table.search(vector).limit(fetchK).toArray();

    return rows
        .map(toMemoryHit)
        .filter((hit) => {
            if (!hit.memory) {
                return false;
            }

            if (kind !== 'findings' && hit.memory.kind !== kind) {
                return false;
            }

            if (selectedIdSet !== undefined && !selectedIdSet.has(hit.memory.id)) {
                return false;
            }

            return true;
        })
        .slice(0, k);
}


interface PathGroup {
    path: string;
    language: string;
    score: number;
    ranges: { start: number; end: number }[];
    repoKey: string;
}

function groupByPath(hits: RawCodeChunkHit[]): Map<string, PathGroup> {
    const groups = new Map<string, PathGroup>();
    for (const hit of hits) {
        const groupKey = `${hit.repoKey}::${hit.path}`;
        const existing = groups.get(groupKey);
        if (existing) {
            existing.ranges.push({ start: hit.startLine, end: hit.endLine });
            if (hit.score > existing.score) existing.score = hit.score;
        } else {
            groups.set(groupKey, {
                path: hit.path,
                language: hit.language,
                score: hit.score,
                ranges: [{ start: hit.startLine, end: hit.endLine }],
                repoKey: hit.repoKey,
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


function clamp(n: number, min: number, max: number): number {
    if (n < min) return min;
    if (n > max) return max;

    return n;
}
