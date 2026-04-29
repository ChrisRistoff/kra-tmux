import { docsSearch } from '@/AI/AIAgent/shared/docs/search';
import { embedOne } from '@/AI/AIAgent/shared/memory/embedder';
import { getDocChunksTable } from '@/AI/AIAgent/shared/memory/db';

jest.mock('@/AI/AIAgent/shared/memory/embedder', () => ({
    embedOne: jest.fn(async () => [0.1, 0.2, 0.3]),
}));

jest.mock('@/AI/AIAgent/shared/memory/db', () => ({
    getDocChunksTable: jest.fn(),
}));

const mockedEmbedOne = jest.mocked(embedOne);
const mockedGetDocChunksTable = jest.mocked(getDocChunksTable);

interface MockRow {
    id: string;
    sourceAlias: string;
    url: string;
    pageTitle: string;
    sectionPath: string;
    chunkIndex: number;
    tokenCount: number;
    content: string;
    contentHash: string;
    indexedAt: number;
    vector: number[];
    _distance: number;
}

function row(overrides: Partial<MockRow>): MockRow {
    return {
        id: 'id',
        sourceAlias: 'aws',
        url: 'https://docs.aws/p',
        pageTitle: 'A page',
        sectionPath: 'A page > Intro',
        chunkIndex: 0,
        tokenCount: 100,
        content: 'body',
        contentHash: 'h',
        indexedAt: 0,
        vector: [],
        _distance: 0.1,
        ...overrides,
    };
}

function mockTable(rows: MockRow[]): void {
    const search = jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue(rows),
        }),
    });
    mockedGetDocChunksTable.mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        table: { search } as any,
        justCreated: false,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbedOne.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe('docsSearch', () => {
    it('throws on empty query', async () => {
        await expect(docsSearch({ query: '' })).rejects.toThrow(/query is required/);
        await expect(docsSearch({ query: '   ' })).rejects.toThrow(/query is required/);
    });

    it('returns [] when the doc_chunks table does not exist yet', async () => {
        mockedGetDocChunksTable.mockResolvedValue({ table: null, justCreated: false });
        const out = await docsSearch({ query: 'anything' });
        expect(out).toEqual([]);
    });

    it('groups multiple chunks of the same page into a single hit with sections sorted by score', async () => {
        mockTable([
            row({ id: '1', url: 'https://docs.aws/p1', sectionPath: 'P1 > A', chunkIndex: 0, content: 'a', _distance: 0.5 }),
            row({ id: '2', url: 'https://docs.aws/p1', sectionPath: 'P1 > B', chunkIndex: 1, content: 'b', _distance: 0.1 }),
            row({ id: '3', url: 'https://docs.aws/p1', sectionPath: 'P1 > C', chunkIndex: 2, content: 'c', _distance: 0.3 }),
        ]);

        const hits = await docsSearch({ query: 'foo' });
        expect(hits).toHaveLength(1);
        expect(hits[0].url).toBe('https://docs.aws/p1');
        expect(hits[0].sections.map((s) => s.sectionPath)).toEqual(['P1 > B', 'P1 > C', 'P1 > A']);
        expect(hits[0].score).toBeCloseTo(1 / (1 + 0.1));
    });

    it('caps sections per page at 3 (best by score)', async () => {
        mockTable([
            row({ id: '1', url: 'https://x/p', sectionPath: 'S1', chunkIndex: 0, _distance: 0.4 }),
            row({ id: '2', url: 'https://x/p', sectionPath: 'S2', chunkIndex: 1, _distance: 0.1 }),
            row({ id: '3', url: 'https://x/p', sectionPath: 'S3', chunkIndex: 2, _distance: 0.2 }),
            row({ id: '4', url: 'https://x/p', sectionPath: 'S4', chunkIndex: 3, _distance: 0.3 }),
            row({ id: '5', url: 'https://x/p', sectionPath: 'S5', chunkIndex: 4, _distance: 0.5 }),
        ]);
        const hits = await docsSearch({ query: 'foo' });
        expect(hits[0].sections).toHaveLength(3);
        expect(hits[0].sections.map((s) => s.sectionPath)).toEqual(['S2', 'S3', 'S4']);
    });

    it('truncates very long content and flags it', async () => {
        const long = 'x'.repeat(2000);
        mockTable([row({ content: long, _distance: 0.1 })]);
        const hits = await docsSearch({ query: 'foo' });
        expect(hits[0].sections[0].truncated).toBe(true);
        expect(hits[0].sections[0].content.length).toBeLessThan(long.length);
        expect(hits[0].sections[0].content).toContain('[truncated]');
    });

    it('does not truncate short content', async () => {
        mockTable([row({ content: 'short body', _distance: 0.1 })]);
        const hits = await docsSearch({ query: 'foo' });
        expect(hits[0].sections[0].truncated).toBe(false);
        expect(hits[0].sections[0].content).toBe('short body');
    });

    it('drops hits below MIN_SCORE (high distance)', async () => {
        mockTable([
            row({ url: 'https://x/good', _distance: 0.1 }),
            row({ url: 'https://x/bad', _distance: 5.0 }),
        ]);
        const hits = await docsSearch({ query: 'foo' });
        expect(hits.map((h) => h.url)).toEqual(['https://x/good']);
    });

    it('respects sourceAlias filter', async () => {
        mockTable([
            row({ sourceAlias: 'aws', url: 'https://aws/p', _distance: 0.1 }),
            row({ sourceAlias: 'gcp', url: 'https://gcp/p', _distance: 0.05 }),
        ]);
        const hits = await docsSearch({ query: 'foo', sourceAlias: 'aws' });
        expect(hits.map((h) => h.sourceAlias)).toEqual(['aws']);
    });

    it('clamps k to [1, 50] and orders pages by best section score', async () => {
        mockTable([
            row({ url: 'https://x/a', _distance: 0.4 }),
            row({ url: 'https://x/b', _distance: 0.1 }),
            row({ url: 'https://x/c', _distance: 0.2 }),
        ]);
        const hits = await docsSearch({ query: 'foo', k: 2 });
        expect(hits.map((h) => h.url)).toEqual(['https://x/b', 'https://x/c']);
    });

    it('handles missing _distance as score 0 (filtered out)', async () => {
        mockTable([
            // @ts-expect-error force missing distance
            row({ url: 'https://x/no-dist', _distance: undefined }),
            row({ url: 'https://x/keep', _distance: 0.1 }),
        ]);
        const hits = await docsSearch({ query: 'foo' });
        expect(hits.map((h) => h.url)).toEqual(['https://x/keep']);
    });
});
