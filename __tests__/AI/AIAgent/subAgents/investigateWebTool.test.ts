import {
    coerceWebResult,
    validateWebEvidence,
    type WebEvidenceItem,
} from '@/AI/AIAgent/shared/subAgents/investigateWebTool';
import { embedOne } from '@/AI/AIAgent/shared/memory/embedder';
import { searchResearchChunks } from '@/AI/AIAgent/shared/memory/researchChunks';
import type { WebResearchToolStats } from '@/AI/AIAgent/shared/subAgents/webResearchTools';

jest.mock('@/AI/AIAgent/shared/memory/embedder', () => ({
    embedOne: jest.fn(async () => [0.1, 0.2, 0.3]),
}));
jest.mock('@/AI/AIAgent/shared/memory/researchChunks', () => ({
    searchResearchChunks: jest.fn(),
}));

const mockedEmbedOne = jest.mocked(embedOne);
const mockedSearch = jest.mocked(searchResearchChunks);

const baseStats: WebResearchToolStats = {
    searches: 1,
    scrapes: 1,
    pagesFetched: 2,
    pagesFailed: 0,
    chunksIndexed: 5,
};

describe('investigateWebTool.coerceWebResult', () => {
    it('parses a complete result and projects stats', () => {
        const parsed = coerceWebResult(
            {
                summary: 'X works because Y',
                evidence: [
                    {
                        url: 'https://docs.example/foo',
                        title: 'Foo',
                        section: 'API',
                        excerpt: 'foo() is idempotent',
                        why_relevant: 'states the property under test',
                    },
                ],
                confidence: 'high',
                suggested_next: 'check bar',
                partial: true,
            },
            baseStats,
        );

        expect(parsed.summary).toBe('X works because Y');
        expect(parsed.evidence).toHaveLength(1);
        expect(parsed.evidence[0]?.url).toBe('https://docs.example/foo');
        expect(parsed.evidence[0]?.title).toBe('Foo');
        expect(parsed.confidence).toBe('high');
        expect(parsed.suggested_next).toBe('check bar');
        expect(parsed.partial).toBe(true);
        expect(parsed.pages_fetched).toBe(2);
        expect(parsed.scrapes).toBe(1);
        expect(parsed.chunks_indexed).toBe(5);
    });

    it('drops malformed evidence entries (missing required fields)', () => {
        const parsed = coerceWebResult(
            {
                summary: '',
                evidence: [
                    { url: 'https://a', excerpt: 'x', why_relevant: 'y' },
                    { url: 'https://b' }, // missing excerpt + why_relevant
                    'garbage',
                    { excerpt: 'x', why_relevant: 'y' }, // missing url
                    { url: 'https://c', excerpt: 'z', why_relevant: 'w' },
                ],
            },
            baseStats,
        );

        expect(parsed.evidence.map((e) => e.url)).toEqual(['https://a', 'https://c']);
    });

    it('falls back to a sensible default for missing/invalid confidence', () => {
        const missing = coerceWebResult({ summary: '', evidence: [] }, baseStats).confidence;
        const invalid = coerceWebResult(
            { summary: '', evidence: [], confidence: 'mystery' },
            baseStats,
        ).confidence;

        expect(['high', 'medium', 'low']).toContain(missing);
        expect(missing).toBe(invalid);
    });
});

describe('investigateWebTool.validateWebEvidence', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedEmbedOne.mockResolvedValue([0.1, 0.2, 0.3]);
    });

    function evidence(overrides: Partial<WebEvidenceItem> = {}): WebEvidenceItem {
        return {
            url: 'https://docs.example/foo',
            excerpt: 'foo() is idempotent',
            why_relevant: 'states the property',
            ...overrides,
        };
    }

    it('keeps evidence whose excerpt is contained in a same-URL hit', async () => {
        mockedSearch.mockResolvedValueOnce([
            {
                url: 'https://docs.example/foo',
                title: 'Foo',
                sectionPath: 'API',
                chunkIndex: 0,
                content: 'Notes: foo() is idempotent and safe to retry.',
                fetchedAt: Date.now(),
                score: 0.9,
            },
        ]);

        const validated = await validateWebEvidence([evidence()], 'rid', 60_000);

        expect(validated).toHaveLength(1);
        expect(validated[0]?.why_relevant).toBe('states the property');
    });

    it('flags evidence not present in any indexed chunk', async () => {
        mockedSearch.mockResolvedValueOnce([
            {
                url: 'https://docs.example/foo',
                title: 'Foo',
                sectionPath: 'API',
                chunkIndex: 0,
                content: 'Completely unrelated text about other things.',
                fetchedAt: Date.now(),
                score: 0.4,
            },
        ]);

        const validated = await validateWebEvidence([evidence()], 'rid', 60_000);
        expect(validated[0]?.why_relevant).toMatch(/^\[unverified: excerpt not found/);
    });

    it('falls back to all hits when there are no same-URL matches', async () => {
        mockedSearch.mockResolvedValueOnce([
            {
                url: 'https://other.example/page',
                title: 'Other',
                sectionPath: '',
                chunkIndex: 0,
                content: 'Quoting docs: foo() is idempotent. Source: docs.example.',
                fetchedAt: Date.now(),
                score: 0.7,
            },
        ]);

        const validated = await validateWebEvidence([evidence()], 'rid', 60_000);
        expect(validated[0]?.why_relevant).toBe('states the property');
    });

    it('tolerates whitespace / case differences when matching', async () => {
        mockedSearch.mockResolvedValueOnce([
            {
                url: 'https://docs.example/foo',
                title: 'Foo',
                sectionPath: '',
                chunkIndex: 0,
                content: 'FOO()    is\nidempotent.',
                fetchedAt: Date.now(),
                score: 0.8,
            },
        ]);

        const validated = await validateWebEvidence(
            [evidence({ excerpt: 'foo() is idempotent' })],
            'rid',
            60_000,
        );
        expect(validated[0]?.why_relevant).toBe('states the property');
    });

    it('flags items when the search throws', async () => {
        mockedSearch.mockRejectedValueOnce(new Error('table missing'));

        const validated = await validateWebEvidence([evidence()], 'rid', 60_000);
        expect(validated[0]?.why_relevant).toMatch(/^\[unverified: validation error: table missing/);
    });
});
