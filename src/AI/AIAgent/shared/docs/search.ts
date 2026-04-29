/**
 * Vector search over the doc_chunks table populated by `kra ai docs`.
 *
 * Mirrors the shape of `semanticSearch` (memory/search.ts) but tuned for
 * documentation: it returns the actual chunk content (capped) rather than
 * just file ranges, since the agent has no other way to pull the markdown
 * back. Hits are aggregated per page (sourceAlias + url) so the agent gets
 * one logical entry per page with the best-scoring sections inlined.
 */
import { embedOne } from '../memory/embedder';
import { getDocChunksTable } from '../memory/db';
import type { DocChunkRow } from './types';

const MIN_SCORE = 0.5;
const MAX_K = 50;
const DEFAULT_K = 8;
const SECTIONS_PER_PAGE = 3;
const CONTENT_CHAR_BUDGET = 1200;

export interface DocsSearchInput {
    query: string;
    k?: number;
    sourceAlias?: string;
}

export interface DocsSearchSection {
    sectionPath: string;
    chunkIndex: number;
    score: number;
    content: string;
    truncated: boolean;
    tokenCount: number;
}

export interface DocsSearchHit {
    sourceAlias: string;
    url: string;
    pageTitle: string;
    score: number;
    sections: DocsSearchSection[];
}

interface RawDocHit {
    row: DocChunkRow;
    score: number;
}

export async function docsSearch(input: DocsSearchInput): Promise<DocsSearchHit[]> {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error('docsSearch: query is required and must be non-empty');
    }
    const k = clamp(input.k ?? DEFAULT_K, 1, MAX_K);

    const { table } = await getDocChunksTable(null);
    if (!table) return [];

    const queryVector = await embedOne(input.query);

    const fetchK = Math.min(Math.max(k * 8, 40), 400);
    const rows = (await table.search(queryVector).limit(fetchK).toArray()) as Array<DocChunkRow & { _distance?: number }>;

    const aliasFilter = input.sourceAlias?.trim();

    const raw: RawDocHit[] = rows
        .map((row) => ({ row, score: distanceToScore(row._distance) }))
        .filter((hit) => hit.score >= MIN_SCORE)
        .filter((hit) => !aliasFilter || hit.row.sourceAlias === aliasFilter);

    const grouped = groupByPage(raw);
    const topPages = [...grouped.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

    return topPages.map((page) => {
        const sections = page.sections
            .sort((a, b) => b.score - a.score)
            .slice(0, SECTIONS_PER_PAGE)
            .map((s) => buildSection(s));

        return {
            sourceAlias: page.sourceAlias,
            url: page.url,
            pageTitle: page.pageTitle,
            score: page.score,
            sections,
        } satisfies DocsSearchHit;
    });
}

interface PageGroup {
    sourceAlias: string;
    url: string;
    pageTitle: string;
    score: number;
    sections: RawDocHit[];
}

function groupByPage(hits: RawDocHit[]): Map<string, PageGroup> {
    const groups = new Map<string, PageGroup>();
    for (const hit of hits) {
        const key = `${hit.row.sourceAlias}|${hit.row.url}`;
        const existing = groups.get(key);
        if (existing) {
            existing.sections.push(hit);
            if (hit.score > existing.score) existing.score = hit.score;
        } else {
            groups.set(key, {
                sourceAlias: hit.row.sourceAlias,
                url: hit.row.url,
                pageTitle: hit.row.pageTitle,
                score: hit.score,
                sections: [hit],
            });
        }
    }

    return groups;
}

function buildSection(hit: RawDocHit): DocsSearchSection {
    const content = hit.row.content ?? '';
    const truncated = content.length > CONTENT_CHAR_BUDGET;
    const trimmed = truncated ? content.slice(0, CONTENT_CHAR_BUDGET) + '\n…[truncated]' : content;

    return {
        sectionPath: hit.row.sectionPath,
        chunkIndex: hit.row.chunkIndex,
        score: hit.score,
        content: trimmed,
        truncated,
        tokenCount: hit.row.tokenCount,
    };
}

function distanceToScore(distance: number | undefined): number {
    if (typeof distance !== 'number' || Number.isNaN(distance)) return 0;
    if (distance <= 0) return 1;

    return 1 / (1 + distance);
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;

    return value;
}
