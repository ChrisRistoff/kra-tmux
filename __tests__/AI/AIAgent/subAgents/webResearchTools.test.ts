import { createWebResearchTools } from '@/AI/AIAgent/shared/subAgents/webResearchTools';
import {
    fetchPageMarkdown,
    searchPagesStructured,
} from '@/AI/shared/utils/webTools';
import { embedMany, embedOne } from '@/AI/AIAgent/shared/memory/embedder';
import {
    insertResearchChunks,
    searchResearchChunks,
} from '@/AI/AIAgent/shared/memory/researchChunks';
import { chunkMarkdown } from '@/AI/AIAgent/shared/docs/chunker';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';
import type { WebInvestigatorSettings } from '@/AI/AIAgent/shared/subAgents/types';

jest.mock('@/AI/shared/utils/webTools', () => ({
    fetchPageMarkdown: jest.fn(),
    searchPagesStructured: jest.fn(),
}));
jest.mock('@/AI/AIAgent/shared/memory/embedder', () => ({
    embedMany: jest.fn(),
    embedOne: jest.fn(),
}));
jest.mock('@/AI/AIAgent/shared/memory/researchChunks', () => ({
    insertResearchChunks: jest.fn(),
    searchResearchChunks: jest.fn(),
}));
jest.mock('@/AI/AIAgent/shared/docs/chunker', () => ({
    chunkMarkdown: jest.fn(),
}));

const mockedFetch = jest.mocked(fetchPageMarkdown);
const mockedSearchPages = jest.mocked(searchPagesStructured);
const mockedEmbedMany = jest.mocked(embedMany);
const mockedEmbedOne = jest.mocked(embedOne);
const mockedInsert = jest.mocked(insertResearchChunks);
const mockedSearchChunks = jest.mocked(searchResearchChunks);
const mockedChunk = jest.mocked(chunkMarkdown);

const SETTINGS: WebInvestigatorSettings = {
    useInvestigatorRuntime: true,
    maxSearches: 2,
    maxScrapes: 2,
    urlsPerScrape: 5,
    maxToolCalls: 30,
    maxEvidenceItems: 4,
    maxExcerptLines: 20,
    ttlMinutes: 60,
    validateExcerpts: true,
    toolWhitelist: [],
};

function findTool(tools: LocalTool[], name: string): LocalTool {
    const t = tools.find((tool) => tool.name === name);
    if (!t) throw new Error(`tool ${name} missing from factory`);

    return t;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('webResearchTools.web_search', () => {
    it('delegates to searchPagesStructured and tracks quota', async () => {
        mockedSearchPages.mockResolvedValueOnce({
            results: [{ title: 'A', url: 'https://a', snippet: 'snip' }],
        });

        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'web_search');
        const out = JSON.parse(await tool.handler({ query: 'foo', max_results: 3 }) as string);

        expect(mockedSearchPages).toHaveBeenCalledWith('foo', 3);
        expect(out.results).toHaveLength(1);
        expect(out.quota.web_search.used).toBe(1);
        expect(factory.stats().searches).toBe(1);
    });

    it('refuses once the per-investigation quota is exhausted', async () => {
        mockedSearchPages.mockResolvedValue({ results: [] });

        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'web_search');
        await tool.handler({ query: 'q1' });
        await tool.handler({ query: 'q2' });
        const out = JSON.parse(await tool.handler({ query: 'q3' }) as string);

        expect(out.error).toMatch(/web_search quota exhausted/);
        expect(mockedSearchPages).toHaveBeenCalledTimes(2);
    });
});

describe('webResearchTools.web_scrape_and_index', () => {
    function setupSuccessfulScrape() {
        mockedFetch.mockImplementation(async (url: string) => ({
            page: {
                url,
                title: `T-${url}`,
                body: `# ${url}\n\nbody for ${url}`,
                contentType: 'text/markdown',
                via: 'direct',
                fetchedAt: 12_345,
                status: 200,
            },
        }));
        mockedChunk.mockImplementation((body: string) => [
            { sectionPath: 'Intro', content: `${body} chunk1`, contentForEmbedding: '', tokenEstimate: 10 } as never,
            { sectionPath: 'Details', content: `${body} chunk2`, contentForEmbedding: '', tokenEstimate: 10 } as never,
        ]);
        mockedEmbedMany.mockImplementation(async (texts: string[]) =>
            texts.map(() => [0.1, 0.2, 0.3]),
        );
        mockedEmbedOne.mockResolvedValue([0.1, 0.2, 0.3]);
        mockedInsert.mockResolvedValue(undefined);
        mockedSearchChunks.mockResolvedValue([
            {
                url: 'https://a',
                title: 'T-https://a',
                sectionPath: 'Intro',
                chunkIndex: 0,
                content: 'hit content',
                fetchedAt: 12_345,
                score: 0.9,
            },
        ]);
    }

    it('fetches, chunks, embeds, indexes and runs per-query searches', async () => {
        setupSuccessfulScrape();

        const factory = createWebResearchTools('rid-xyz', SETTINGS);
        const tool = findTool(factory.tools, 'web_scrape_and_index');
        const raw = await tool.handler({
            urls: ['https://a', 'https://b'],
            queries: ['what is foo?', 'why is foo idempotent?'],
        }) as string;
        const out = JSON.parse(raw);

        expect(out.scraped).toBe(2);
        expect(out.failed).toEqual([]);
        expect(out.chunks_indexed).toBe(4); // 2 urls × 2 chunks
        expect(out.results).toHaveLength(2);
        expect(out.results[0].query).toBe('what is foo?');
        expect(out.results[0].hits[0].url).toBe('https://a');

        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(mockedEmbedMany).toHaveBeenCalledTimes(1);
        // breadcrumb prefix is reconstructed from sectionPath
        const embeddedTexts = mockedEmbedMany.mock.calls[0]?.[0] as string[];
        expect(embeddedTexts[0]).toMatch(/^# Intro\n\n/);
        // every inserted row carries the researchId
        const insertedRows = mockedInsert.mock.calls[0]?.[0] ?? [];
        expect(insertedRows.every((r) => r.researchId === 'rid-xyz')).toBe(true);
        expect(insertedRows[0]?.fetchedAt).toBe(12_345);

        const stats = factory.stats();
        expect(stats.scrapes).toBe(1);
        expect(stats.pagesFetched).toBe(2);
        expect(stats.pagesFailed).toBe(0);
        expect(stats.chunksIndexed).toBe(4);
    });

    it('reports failures without aborting the rest of the batch', async () => {
        mockedFetch.mockImplementation(async (url: string) => {
            if (url === 'https://bad') return { error: 'HTTP 500' };

            return {
                page: {
                    url,
                    title: 't',
                    body: 'body',
                    contentType: 'text/markdown',
                    via: 'direct',
                    fetchedAt: 1,
                    status: 200,
                },
            };
        });
        mockedChunk.mockReturnValue([
            { sectionPath: '', content: 'c', contentForEmbedding: '', tokenEstimate: 1 } as never,
        ]);
        mockedEmbedMany.mockResolvedValue([[0, 0, 0]]);
        mockedEmbedOne.mockResolvedValue([0, 0, 0]);
        mockedSearchChunks.mockResolvedValue([]);

        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'web_scrape_and_index');
        const out = JSON.parse(await tool.handler({
            urls: ['https://ok', 'https://bad'],
            queries: ['q'],
        }) as string);

        expect(out.scraped).toBe(1);
        expect(out.failed).toEqual([{ url: 'https://bad', error: 'HTTP 500' }]);
        expect(out.chunks_indexed).toBe(1);
        expect(factory.stats().pagesFailed).toBe(1);
    });

    it('truncates the URL list to settings.urlsPerScrape', async () => {
        setupSuccessfulScrape();
        const factory = createWebResearchTools('rid', { ...SETTINGS, urlsPerScrape: 2 });
        const tool = findTool(factory.tools, 'web_scrape_and_index');
        const urls = ['https://a', 'https://b', 'https://c', 'https://d'];

        await tool.handler({ urls, queries: ['q'] });
        expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it('errors early when no URLs or queries are provided', async () => {
        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'web_scrape_and_index');

        const noUrls = JSON.parse(await tool.handler({ urls: [], queries: ['q'] }) as string);
        expect(noUrls.error).toMatch(/No URLs/);

        // Still consumes one quota slot — call again with valid urls but no queries.
        const noQueries = JSON.parse(await tool.handler({ urls: ['https://a'], queries: [] }) as string);
        expect(noQueries.error).toMatch(/No queries/);
    });

    it('refuses once the scrape quota is exhausted', async () => {
        setupSuccessfulScrape();
        const factory = createWebResearchTools('rid', { ...SETTINGS, maxScrapes: 1 });
        const tool = findTool(factory.tools, 'web_scrape_and_index');

        await tool.handler({ urls: ['https://a'], queries: ['q'] });
        const out = JSON.parse(await tool.handler({ urls: ['https://b'], queries: ['q'] }) as string);
        expect(out.error).toMatch(/quota exhausted/);
    });
});

describe('webResearchTools.research_query', () => {
    it('vector-searches scoped to the investigation researchId + ttl', async () => {
        mockedEmbedOne.mockResolvedValue([0.1, 0.2, 0.3]);
        mockedSearchChunks.mockResolvedValue([
            {
                url: 'https://a',
                title: 'A',
                sectionPath: 'Intro',
                chunkIndex: 0,
                content: 'snippet',
                fetchedAt: 1,
                score: 0.5,
            },
        ]);

        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'research_query');
        const out = JSON.parse(await tool.handler({ query: 'sub-q', k: 3 }) as string);

        expect(mockedEmbedOne).toHaveBeenCalledWith('sub-q');
        expect(mockedSearchChunks).toHaveBeenCalledWith(
            expect.objectContaining({
                researchId: 'rid',
                k: 3,
                ttlMs: SETTINGS.ttlMinutes * 60_000,
            }),
        );
        expect(out.hits).toHaveLength(1);
        expect(out.hits[0].score).toBe(0.5);
    });

    it('rejects an empty query', async () => {
        const factory = createWebResearchTools('rid', SETTINGS);
        const tool = findTool(factory.tools, 'research_query');
        const out = JSON.parse(await tool.handler({ query: '' }) as string);
        expect(out.error).toMatch(/Missing required argument/);
        expect(mockedEmbedOne).not.toHaveBeenCalled();
    });

    it('caps k at maxEvidenceItems * 2', async () => {
        mockedEmbedOne.mockResolvedValue([0]);
        mockedSearchChunks.mockResolvedValue([]);

        const factory = createWebResearchTools('rid', { ...SETTINGS, maxEvidenceItems: 3 });
        const tool = findTool(factory.tools, 'research_query');
        await tool.handler({ query: 'q', k: 999 });

        expect(mockedSearchChunks).toHaveBeenCalledWith(
            expect.objectContaining({ k: 6 }),
        );
    });
});
