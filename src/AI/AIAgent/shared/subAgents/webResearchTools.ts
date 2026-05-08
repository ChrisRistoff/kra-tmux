/**
 * Local-tool factory for the `investigate_web` sub-agent.
 *
 * Builds three `LocalTool`s scoped to a single investigation, identified by a
 * fresh `researchId` UUID minted by `createInvestigateWebTool` per call:
 *
 *   - `web_search`            — pure search, returns `[{title, url, snippet}]`.
 *   - `web_scrape_and_index`  — fetches URLs in parallel, chunks them with the
 *                               existing markdown chunker, embeds via
 *                               `embedMany`, inserts rows tagged with this
 *                               investigation's `researchId`, then runs vector
 *                               search per query and returns merged hits.
 *   - `research_query`        — vector search scoped to this investigation +
 *                               TTL filter (no new fetching).
 *
 * The model never sees raw page bodies; only retrieved excerpts. URL filtering
 * is coarse (titles / snippets); fine-grained relevance is the vector search.
 *
 * Per-investigation quotas (searches, scrapes) live in the closure so they're
 * reset for each new `investigate_web` invocation.
 */

import { randomUUID } from 'crypto';
import {
    fetchPageMarkdown,
    searchPagesStructured,
    type FetchedPage,
} from '@/AI/shared/utils/webTools';
import { chunkMarkdown } from '@/AI/AIAgent/shared/docs/chunker';
import { embedMany, embedOne } from '@/AI/AIAgent/shared/memory/embedder';
import {
    insertResearchChunks,
    searchResearchChunks,
    type ResearchHit,
} from '@/AI/AIAgent/shared/memory/researchChunks';
import type { ResearchChunkRow } from '@/AI/AIAgent/shared/memory/types';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';
import type { WebInvestigatorSettings } from './types';

export interface WebResearchToolStats {
    searches: number;
    scrapes: number;
    pagesFetched: number;
    pagesFailed: number;
    chunksIndexed: number;
}

export interface WebResearchToolFactory {
    tools: LocalTool[];
    stats: () => WebResearchToolStats;
}

/**
 * Build the 3 web-research `LocalTool`s for one investigation.
 *
 * `researchId` is the UUID minted for this `investigate_web` call. All chunks
 * indexed during the call are tagged with it, so concurrent investigations
 * don't see each other's data.
 */
export function createWebResearchTools(
    researchId: string,
    settings: WebInvestigatorSettings,
    repoKey?: string,
): WebResearchToolFactory {
    const stats: WebResearchToolStats = {
        searches: 0,
        scrapes: 0,
        pagesFetched: 0,
        pagesFailed: 0,
        chunksIndexed: 0,
    };
    const ttlMs = settings.ttlMinutes * 60_000;

    const webSearch: LocalTool = {
        name: 'web_search',
        serverLabel: 'kra-investigate-web',
        description:
            'Search the web for sources relevant to your research question. '
            + 'Returns up to ~10 results as `{title, url, snippet}`. Use the '
            + 'titles and snippets to triage which URLs to scrape — this call '
            + 'does NOT fetch page bodies. Cheap; spend it freely to refine.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query.' },
                max_results: {
                    type: 'number',
                    description: 'Max results to return (default 8, hard cap 15).',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        handler: async (rawArgs) => {
            if (stats.searches >= settings.maxSearches) {
                return JSON.stringify({
                    error: 'web_search quota exhausted',
                    quota: { used: stats.searches, max: settings.maxSearches },
                });
            }
            stats.searches += 1;

            const args = rawArgs as { query?: unknown; max_results?: unknown };
            const query = typeof args.query === 'string' ? args.query : '';
            const maxResults = typeof args.max_results === 'number'
                ? Math.max(1, Math.min(15, Math.floor(args.max_results)))
                : 8;

            const { results, error } = await searchPagesStructured(query, maxResults);

            return JSON.stringify({
                query,
                results,
                ...(error ? { error } : {}),
                quota: {
                    web_search: { used: stats.searches, max: settings.maxSearches },
                    web_scrape_and_index: { used: stats.scrapes, max: settings.maxScrapes },
                },
            });
        },
    };

    const webScrapeAndIndex: LocalTool = {
        name: 'web_scrape_and_index',
        serverLabel: 'kra-investigate-web',
        description:
            'Fetch a batch of URLs in parallel, chunk + embed them into a '
            + 'private vector index for this investigation, then run vector '
            + 'search using each of the supplied queries and return the most '
            + 'relevant excerpts. The model never sees raw page bodies — only '
            + 'the curated hits returned here. Spend `web_search` first to '
            + 'pick which URLs are worth scraping.',
        parameters: {
            type: 'object',
            properties: {
                urls: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        `URLs to fetch (max ${settings.urlsPerScrape} per call).`,
                },
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Queries to run against the freshly-indexed chunks. '
                        + 'Use 1–4 focused sub-questions; one excerpt list is '
                        + 'returned per query.',
                },
                k: {
                    type: 'number',
                    description: `Hits per query (default 5, hard cap ${settings.maxEvidenceItems * 2}).`,
                },
            },
            required: ['urls', 'queries'],
            additionalProperties: false,
        },
        handler: async (rawArgs) => {
            if (stats.scrapes >= settings.maxScrapes) {
                return JSON.stringify({
                    error: 'web_scrape_and_index quota exhausted',
                    quota: { used: stats.scrapes, max: settings.maxScrapes },
                });
            }
            stats.scrapes += 1;

            const args = rawArgs as {
                urls?: unknown;
                queries?: unknown;
                k?: unknown;
            };

            const urls = Array.isArray(args.urls)
                ? (args.urls.filter((u): u is string => typeof u === 'string'))
                    .slice(0, settings.urlsPerScrape)
                : [];
            const queries = Array.isArray(args.queries)
                ? args.queries.filter((q): q is string => typeof q === 'string' && q.length > 0)
                : [];
            const kCap = settings.maxEvidenceItems * 2;
            const k = typeof args.k === 'number'
                ? Math.max(1, Math.min(kCap, Math.floor(args.k)))
                : 5;

            if (urls.length === 0) {
                return JSON.stringify({ error: 'No URLs provided to scrape.' });
            }
            if (queries.length === 0) {
                return JSON.stringify({ error: 'No queries provided to search the indexed chunks.' });
            }

            // Parallel fetch; per-URL failures collected, never block the batch.
            const fetched = await Promise.all(urls.map(async (url) => {
                try {
                    const r = await fetchPageMarkdown(url);

                    return r.page
                        ? { ok: true as const, page: r.page }
                        : { ok: false as const, url, error: r.error ?? 'unknown error' };
                } catch (e) {
                    return {
                        ok: false as const,
                        url,
                        error: e instanceof Error ? e.message : String(e),
                    };
                }
            }));

            const successes = fetched.filter((f): f is { ok: true; page: FetchedPage } => f.ok);
            const failures = fetched.filter((f): f is { ok: false; url: string; error: string } => !f.ok);
            stats.pagesFetched += successes.length;
            stats.pagesFailed += failures.length;

            // Chunk every successful page; track which page each chunk came from.
            const rowsToInsert: ResearchChunkRow[] = [];
            for (const { page } of successes) {
                const chunks = chunkMarkdown(page.body, { pageTitle: page.title });
                chunks.forEach((c, idx) => {
                    rowsToInsert.push({
                        id: randomUUID(),
                        researchId,
                        url: page.url,
                        title: page.title,
                        sectionPath: c.sectionPath,
                        chunkIndex: idx,
                        content: c.content,
                        fetchedAt: page.fetchedAt,
                        // vector filled in next step
                        vector: [],
                    });
                });
            }

            if (rowsToInsert.length > 0) {
                const vectors = await embedMany(
                    rowsToInsert.map((_, i) => {
                        // Mirror chunkMarkdown's contentForEmbedding shape so the
                        // breadcrumb is part of the indexed text. We didn't keep
                        // the chunk objects around so reconstruct from row fields.
                        const row = rowsToInsert[i];
                        const breadcrumb = row.sectionPath ? `# ${row.sectionPath}\n\n` : '';

                        return breadcrumb + row.content;
                    }),
                );
                rowsToInsert.forEach((row, i) => {
                    row.vector = vectors[i];
                });

                try {
                    await insertResearchChunks(rowsToInsert, repoKey);
                    stats.chunksIndexed += rowsToInsert.length;
                } catch (e) {
                    return JSON.stringify({
                        error: 'Failed to index chunks',
                        detail: e instanceof Error ? e.message : String(e),
                        scraped: successes.length,
                        failed: failures.map((f) => ({ url: f.url, error: f.error })),
                    });
                }
            }

            // Vector search for each requested query.
            const results = await Promise.all(queries.map(async (q) => {
                const vector = await embedOne(q);
                const hits = await searchResearchChunks({
                    researchId,
                    vector,
                    k,
                    ttlMs,
                    ...(repoKey !== undefined ? { repoKey } : {}),
                });

                return {
                    query: q,
                    hits: hits.map(formatHit),
                };
            }));

            return JSON.stringify({
                scraped: successes.length,
                failed: failures.map((f) => ({ url: f.url, error: f.error })),
                chunks_indexed: rowsToInsert.length,
                results,
                quota: {
                    web_search: { used: stats.searches, max: settings.maxSearches },
                    web_scrape_and_index: { used: stats.scrapes, max: settings.maxScrapes },
                },
            });
        },
    };

    const researchQuery: LocalTool = {
        name: 'research_query',
        serverLabel: 'kra-investigate-web',
        description:
            'Vector-search the chunks already indexed during this '
            + 'investigation. Use this to dig into pages you already scraped '
            + 'with `web_scrape_and_index` without re-fetching them. Returns '
            + 'top-k excerpts with `{url, title, sectionPath, excerpt, score}`.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Sub-question to retrieve excerpts for.' },
                k: {
                    type: 'number',
                    description: `Hits to return (default 5, hard cap ${settings.maxEvidenceItems * 2}).`,
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        handler: async (rawArgs) => {
            const args = rawArgs as { query?: unknown; k?: unknown };
            const query = typeof args.query === 'string' ? args.query : '';
            if (!query) return JSON.stringify({ error: 'Missing required argument: query' });
            const kCap = settings.maxEvidenceItems * 2;
            const k = typeof args.k === 'number'
                ? Math.max(1, Math.min(kCap, Math.floor(args.k)))
                : 5;

            const vector = await embedOne(query);
            const hits = await searchResearchChunks({
                researchId,
                vector,
                k,
                ttlMs,
                ...(repoKey !== undefined ? { repoKey } : {}),
            });

            return JSON.stringify({
                query,
                hits: hits.map(formatHit),
                indexed_chunks_total: stats.chunksIndexed,
            });
        },
    };

    return {
        tools: [webSearch, webScrapeAndIndex, researchQuery],
        stats: () => ({ ...stats }),
    };
}

function formatHit(hit: ResearchHit): {
    url: string;
    title: string;
    sectionPath: string;
    excerpt: string;
    score: number;
} {
    return {
        url: hit.url,
        title: hit.title,
        sectionPath: hit.sectionPath,
        excerpt: hit.content,
        score: Number(hit.score.toFixed(4)),
    };
}
