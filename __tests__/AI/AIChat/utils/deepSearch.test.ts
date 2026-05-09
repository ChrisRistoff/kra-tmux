/**
 * Tests for `runDeepSearch` — the chat-side `deep_search` inner loop.
 *
 * These tests focus on loop behaviour (budget enforcement, submit_result
 * termination, error handling). The web tooling and OpenAI client are both
 * stubbed; we never make a network call.
 */

import type OpenAI from 'openai';
import { runDeepSearch } from '@/AI/AIChat/utils/deepSearch/chatSubAgent';
import type { DeepSearchSettings } from '@/AI/AIChat/utils/deepSearch/settings';
import * as webResearchTools from '@/AI/AIAgent/shared/subAgents/webResearchTools';

jest.mock('@/AI/AIAgent/shared/subAgents/webResearchTools');

const mockedFactory = jest.mocked(webResearchTools.createWebResearchTools);

const SETTINGS: DeepSearchSettings = {
    enabled: true,
    useInvestigatorRuntime: true,
    maxSearches: 5,
    maxScrapes: 5,
    urlsPerScrape: 30,
    maxToolCalls: 4,
    maxEvidenceItems: 8,
    maxExcerptLines: 20,
    ttlMinutes: 60,
    validateExcerpts: true,
    toolWhitelist: ['web_search', 'web_scrape_and_index', 'research_query'],
};

interface FakeToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

/**
 * Build a fake streaming response: yields a single chunk that mirrors the
 * delta shape `accumulateStream` consumes. Mirrors what a real provider
 * sends for a tiny response. We don't bother splitting across multiple chunks
 * — `accumulateStream` only cares that index/id/name/arguments accumulate.
 */
function makeAssistantMsg(toolCalls: FakeToolCall[], content = ''): AsyncIterable<unknown> {
    const tcDeltas = toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    const chunk = {
        choices: [{
            index: 0,
            delta: {
                role: 'assistant',
                content,
                ...(tcDeltas.length ? { tool_calls: tcDeltas } : {}),
            },
            finish_reason: tcDeltas.length ? 'tool_calls' : 'stop',
        }],
    };

    return {
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
            yield chunk;
        },
    };
}

function makeOpenAi(responses: unknown[]): OpenAI {
    const create = jest.fn();
    for (const r of responses) create.mockResolvedValueOnce(r);

    return { chat: { completions: { create } } } as unknown as OpenAI;
}

function stubFactory(handlers: Record<string, jest.Mock> = {}): void {
    const stats = { searches: 0, scrapes: 0, pagesFetched: 0, pagesFailed: 0, chunksIndexed: 0 };
    mockedFactory.mockReturnValue({
        tools: [
            {
                name: 'web_search',
                description: 'search',
                parameters: { type: 'object' },
                handler: handlers.web_search ?? jest.fn().mockResolvedValue('[]'),
            },
            {
                name: 'web_scrape_and_index',
                description: 'scrape',
                parameters: { type: 'object' },
                handler: handlers.web_scrape_and_index ?? jest.fn().mockResolvedValue('{}'),
            },
            {
                name: 'research_query',
                description: 'query',
                parameters: { type: 'object' },
                handler: handlers.research_query ?? jest.fn().mockResolvedValue('{}'),
            },
        ],
        stats: () => stats,
    } as unknown as ReturnType<typeof webResearchTools.createWebResearchTools>);
}

describe('runDeepSearch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('terminates when the model calls submit_result and returns the digest', async () => {
        stubFactory();
        const submitArgs = JSON.stringify({
            summary: 'final answer',
            evidence: [{ url: 'https://a.example', excerpt: 'snippet' }],
            confidence: 'high',
        });
        const openai = makeOpenAi([
            makeAssistantMsg([{ id: '1', type: 'function', function: { name: 'submit_result', arguments: submitArgs } }]),
        ]);

        const result = await runDeepSearch({
            query: 'q',
            provider: 'open-ai',
            model: 'gpt-x',
            settings: SETTINGS,
            openai,
        });

        expect(result.summary).toBe('final answer');
        expect(result.evidence).toEqual([{ url: 'https://a.example', excerpt: 'snippet' }]);
        expect(result.confidence).toBe('high');
        expect(result.partial).toBeUndefined();
        expect(result.stats.toolCalls).toBe(1);
    });

    it('dispatches tool calls to the LocalTool handlers', async () => {
        const searchHandler = jest.fn().mockResolvedValue('[{"url":"https://x"}]');
        stubFactory({ web_search: searchHandler });

        const openai = makeOpenAi([
            makeAssistantMsg([{ id: '1', type: 'function', function: { name: 'web_search', arguments: '{"query":"foo"}' } }]),
            makeAssistantMsg([{ id: '2', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify({ summary: 'done', evidence: [] }) } }]),
        ]);

        const result = await runDeepSearch({
            query: 'q', provider: 'open-ai', model: 'gpt-x', settings: SETTINGS, openai,
        });

        expect(searchHandler).toHaveBeenCalledWith({ query: 'foo' });
        expect(result.stats.toolCalls).toBe(2);
    });

    it('caps tool calls at maxToolCalls and forces a final submit_result', async () => {
        stubFactory();
        const callMsg = (id: string): ReturnType<typeof makeAssistantMsg> => makeAssistantMsg([
            { id, type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
        ]);
        // 4 turns of 1 call each (matches maxToolCalls=4), then a final submit forced via tool_choice.
        const openai = makeOpenAi([
            callMsg('a'), callMsg('b'), callMsg('c'), callMsg('d'),
            makeAssistantMsg([{ id: 'final', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify({ summary: 'partial', evidence: [] }) } }]),
        ]);

        const result = await runDeepSearch({
            query: 'q', provider: 'open-ai', model: 'gpt-x', settings: SETTINGS, openai,
        });

        expect(result.partial).toBe(true);
        expect(result.reason).toBe('budget_exhausted');
        expect(result.summary).toBe('partial');
    });

    it('returns a partial result when the provider errors', async () => {
        stubFactory();
        const create = jest.fn().mockRejectedValue(new Error('function calling unsupported'));
        const openai = { chat: { completions: { create } } } as unknown as OpenAI;

        const result = await runDeepSearch({
            query: 'q', provider: 'open-ai', model: 'gpt-x', settings: SETTINGS, openai,
        });

        expect(result.partial).toBe(true);
        expect(result.reason).toBe('provider_error');
        expect(result.summary).toContain('function calling unsupported');
    });

    it('handles unknown tool calls without crashing', async () => {
        stubFactory();
        const openai = makeOpenAi([
            makeAssistantMsg([{ id: '1', type: 'function', function: { name: 'mystery', arguments: '{}' } }]),
            makeAssistantMsg([{ id: '2', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify({ summary: 'ok', evidence: [] }) } }]),
        ]);

        const result = await runDeepSearch({
            query: 'q', provider: 'open-ai', model: 'gpt-x', settings: SETTINGS, openai,
        });

        expect(result.summary).toBe('ok');
    });

    it('truncates excerpts to maxExcerptLines and caps evidence items', async () => {
        stubFactory();
        const longExcerpt = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
        const evidence = Array.from({ length: 20 }, (_, i) => ({
            url: `https://e${i}.example`,
            excerpt: longExcerpt,
        }));
        const openai = makeOpenAi([
            makeAssistantMsg([{ id: '1', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify({ summary: 's', evidence }) } }]),
        ]);

        const result = await runDeepSearch({
            query: 'q', provider: 'open-ai', model: 'gpt-x', settings: SETTINGS, openai,
        });

        expect(result.evidence).toHaveLength(SETTINGS.maxEvidenceItems);
        expect(result.evidence[0].excerpt.split('\n')).toHaveLength(SETTINGS.maxExcerptLines);
    });
});
