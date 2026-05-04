/**
 * Hybrid (vector + full-text) retrieval for any LanceDB table whose schema
 * has an `id: string` primary key, a `content: string` column, and a
 * vector column compatible with the query vector.
 *
 * Both `code_chunks` (per-repo, used by semantic_search) and `doc_chunks`
 * (global, used by docs_search) share this exact retrieval shape. The
 * caller is responsible for grouping/formatting the results.
 *
 * Algorithm:
 *   1. Run vector search and FTS in parallel (fetchK candidates each).
 *   2. Fuse the two rankings with Reciprocal Rank Fusion (k = RRF_K).
 *   3. Drop vector-only candidates whose cosine score is below
 *      `minVectorScore` (a hit that survived FTS is kept regardless).
 *   4. Normalize the RRF scores to [0, 1] so they remain comparable to the
 *      cosine scores produced by other code paths.
 *
 * If the FTS index does not exist yet (created lazily on first table open),
 * or the FTS query parser rejects the input, the function transparently
 * falls back to vector-only.
 */

import { Index, type Table } from '@lancedb/lancedb';

// Reciprocal Rank Fusion constant. 60 is the value from the original
// Cormack et al. paper and the de-facto default in Elasticsearch / Vespa.
const RRF_K = 60;

export interface HybridSearchOptions {
    /**
     * Maximum number of candidates to pull from each ranking before
     * fusion. The caller typically sets this to 8x the requested k so
     * downstream grouping/dedup still leaves enough distinct entries.
     */
    fetchK: number;
    /**
     * Minimum cosine similarity for a vector-only candidate to be kept.
     * Hits that also appear in the FTS ranking bypass this threshold.
     */
    minVectorScore: number;
}

export interface HybridSearchHit {
    /** The raw LanceDB row (caller casts to its row type). */
    row: Record<string, unknown>;
    /** Normalized fusion score in [0, 1]. */
    score: number;
}

/**
 * Run a hybrid vector + FTS search on the given table and return rows
 * fused by RRF, sorted high-to-low by normalized score.
 */
export async function hybridSearch(
    table: Table,
    queryText: string,
    queryVector: number[],
    opts: HybridSearchOptions,
): Promise<HybridSearchHit[]> {
    const ftsQuery = sanitizeFtsQuery(queryText);

    const [vectorRows, ftsRows] = await Promise.all([
        table.search(queryVector).limit(opts.fetchK).toArray(),
        ftsQuery
            ? table.search(ftsQuery, 'fts', 'content').limit(opts.fetchK).toArray().catch(() => [])
            : Promise.resolve([] as Record<string, unknown>[]),
    ]);

    // When FTS returned nothing (index missing, parser rejected the query,
    // or the corpus has no lexical matches), fall back to pure cosine scoring.
    // RRF without a second ranking would just throw away score magnitudes.
    if (ftsRows.length === 0) {
        const out: HybridSearchHit[] = [];
        for (const row of vectorRows) {
            const r: Record<string, unknown> = row;
            const score = distanceToScore((r as { _distance?: number })._distance);
            if (score < opts.minVectorScore) continue;
            out.push({ row: r, score });
        }
        out.sort((a, b) => b.score - a.score);

        return out;
    }

    const fused = fuseRankings(vectorRows, ftsRows, opts.minVectorScore);

    fused.sort((a, b) => b.score - a.score);

    const max = fused.reduce((m, h) => Math.max(m, h.score), 0);
    if (max <= 0) return fused;

    const norm = 1 / max;
    for (const h of fused) h.score *= norm;

    return fused;
}

/**
 * Best-effort: ensure an FTS index exists on the `content` column of the
 * given table. Idempotent across process lifetime via the supplied
 * `ensuredKeys` set (callers track this per-table). Errors are swallowed
 * so hybrid search transparently falls back to vector-only when the index
 * is unavailable.
 */
export async function ensureContentFtsIndex(
    table: Table,
    cacheKey: string,
    ensuredKeys: Set<string>,
): Promise<void> {
    if (ensuredKeys.has(cacheKey)) return;
    ensuredKeys.add(cacheKey);
    try {
        const indices = await table.listIndices();
        const hasFts = indices.some(
            (i) => i.indexType.toLowerCase().includes('fts') && i.columns.includes('content'),
        );
        if (hasFts) return;
        await table.createIndex('content', { config: Index.fts({ withPosition: false }) });
    } catch {
        ensuredKeys.delete(cacheKey);
    }
}

/**
 * Convert a LanceDB L2 distance to a similarity in [0, 1] via 1/(1+d).
 * Monotonic so sort order is preserved.
 */
export function distanceToScore(distance: number | undefined): number {
    if (typeof distance !== 'number' || !Number.isFinite(distance)) return 0;
    if (distance <= 0) return 1;

    return 1 / (1 + distance);
}

interface FuseEntry {
    row: Record<string, unknown>;
    vRank?: number;
    fRank?: number;
    vScore?: number;
}

function fuseRankings(
    vectorRows: Record<string, unknown>[],
    ftsRows: Record<string, unknown>[],
    minVectorScore: number,
): HybridSearchHit[] {
    const byId = new Map<string, FuseEntry>();

    vectorRows.forEach((row, idx) => {
        const id = String((row as { id?: unknown }).id ?? '');
        if (!id) return;
        const score = distanceToScore((row as { _distance?: number })._distance);
        byId.set(id, { row, vRank: idx, vScore: score });
    });

    ftsRows.forEach((row, idx) => {
        const id = String((row as { id?: unknown }).id ?? '');
        if (!id) return;
        const existing = byId.get(id);
        if (existing) {
            existing.fRank = idx;
        } else {
            byId.set(id, { row, fRank: idx });
        }
    });

    const out: HybridSearchHit[] = [];
    for (const entry of byId.values()) {
        const vectorOnly = entry.fRank === undefined;
        if (vectorOnly && (entry.vScore ?? 0) < minVectorScore) continue;

        let rrf = 0;
        if (entry.vRank !== undefined) rrf += 1 / (RRF_K + entry.vRank + 1);
        if (entry.fRank !== undefined) rrf += 1 / (RRF_K + entry.fRank + 1);

        out.push({ row: entry.row, score: rrf });
    }

    return out;
}

/**
 * Strip characters the LanceDB FTS query parser treats as operators so a
 * free-form user query (which often contains code-y punctuation) can't
 * crash the parser. Semantic search is the primary signal — FTS is just a
 * lexical boost — so a permissive sanitizer is fine.
 */
function sanitizeFtsQuery(query: string): string {
    return query
        .replace(/[+\-!(){}\[\]^"~*?:\\\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
