/**
 * Helpers for the `research_chunks` LanceDB table — the per-investigation
 * vector store used by the `investigate_web` sub-agent.
 *
 * Lifecycle:
 *   1. `investigate_web` mints a fresh `researchId` (UUID) and, on its first
 *      `web_scrape_and_index` call, inserts chunks tagged with that id.
 *   2. `research_query` and the post-scrape semantic search filter by
 *      `researchId` and a TTL window (default 60 min) so concurrent
 *      investigations never cross-contaminate and stale rows are ignored.
 *   3. Cleanup is hybrid: lazy TTL purge on every new investigation start,
 *      explicit delete-by-researchId on SIGINT/exit, and an upper-bound TTL
 *      filter on every query as defence-in-depth.
 */

import { getResearchChunksTable } from './db';
import type { ResearchChunkRow } from './types';

export interface ResearchHit {
    url: string;
    title: string;
    sectionPath: string;
    chunkIndex: number;
    content: string;
    score: number;
    fetchedAt: number;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Insert a batch of chunks into the research_chunks table. Creates the table
 * on first use (using the first row as the seed schema). No-op for empty
 * batches. Errors propagate so callers can surface them.
 */
export async function insertResearchChunks(
    rows: ResearchChunkRow[],
    repoKey?: string,
): Promise<void> {
    if (rows.length === 0) return;

    const { table } = await getResearchChunksTable(rows[0], repoKey);
    if (!table) {
        throw new Error('research_chunks table unavailable after seed insert');
    }

    if (rows.length === 1) {
        return;
    }

    await table.add(rows.slice(1) as unknown as Record<string, unknown>[]);
}

export interface SearchResearchChunksInput {
    researchId: string;
    vector: number[];
    k?: number;
    ttlMs?: number;
    repoKey?: string;
}

/**
 * Vector search scoped to a single `researchId`, with a TTL filter.
 *
 * `ttlMs` is applied as `fetchedAt > now() - ttlMs`. When the table doesn't
 * exist yet (e.g. first-ever query for a research id), returns an empty
 * array rather than throwing.
 */
export async function searchResearchChunks(
    input: SearchResearchChunksInput,
): Promise<ResearchHit[]> {
    const { researchId, vector, k = 8, ttlMs, repoKey } = input;
    const { table } = await getResearchChunksTable(null, repoKey);
    if (!table) return [];

    const cutoff = ttlMs !== undefined ? Date.now() - ttlMs : 0;
    const filter = `researchId = '${escapeSqlLiteral(researchId)}'`
        + (cutoff > 0 ? ` AND fetchedAt > ${cutoff}` : '');

    const fetchK = Math.min(Math.max(k * 4, 20), 200);

    let raw: Record<string, unknown>[];
    try {
        raw = await table.search(vector).where(filter).limit(fetchK).toArray();
    } catch {
        return [];
    }

    return raw
        .map((row): ResearchHit => {
            const r = row as unknown as ResearchChunkRow & { _distance?: number };
            const distance = typeof r._distance === 'number' ? r._distance : 1;

            return {
                url: r.url,
                title: r.title,
                sectionPath: r.sectionPath,
                chunkIndex: r.chunkIndex,
                content: r.content,
                fetchedAt: r.fetchedAt,
                score: 1 / (1 + Math.max(0, distance)),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

/**
 * Delete all rows for the given researchIds. Used by the SIGINT/exit cleanup
 * hook so an interrupted investigation doesn't leak rows past its session.
 * No-op if the table doesn't exist or the list is empty.
 */
export async function deleteByResearchIds(
    researchIds: string[],
    repoKey?: string,
): Promise<void> {
    if (researchIds.length === 0) return;
    const { table } = await getResearchChunksTable(null, repoKey);
    if (!table) return;

    const list = researchIds
        .map((id) => `'${escapeSqlLiteral(id)}'`)
        .join(', ');
    try {
        await table.delete(`researchId IN (${list})`);
    } catch {
        // Best-effort cleanup; never let a delete error mask the real flow.
    }
}

/**
 * Purge rows older than the cutoff. Called at the start of every new
 * `investigate_web` invocation so disk usage stays bounded. No-op if the
 * table doesn't exist.
 */
export async function deleteResearchChunksOlderThan(
    cutoffMs: number,
    repoKey?: string,
): Promise<void> {
    const { table } = await getResearchChunksTable(null, repoKey);
    if (!table) return;

    try {
        await table.delete(`fetchedAt < ${cutoffMs}`);
    } catch {
        // Same as above — best-effort.
    }
}
