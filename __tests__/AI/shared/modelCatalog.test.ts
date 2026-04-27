import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('os', () => {
    const actual = jest.requireActual('os');

    return { ...actual, homedir: jest.fn(actual.homedir) };
});

import {
    formatModelInfoForPicker,
    getModelCatalog,
    type ModelInfo,
} from '@/AI/shared/data/modelCatalog';

describe('modelCatalog', () => {
    const realFetch = global.fetch;
    const realHome = process.env['HOME'];
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-test-'));
        (os.homedir as jest.Mock).mockReturnValue(tmpHome);
    });

    afterEach(() => {
        if (realHome === undefined) {
            delete process.env['HOME'];
        } else {
            process.env['HOME'] = realHome;
        }
        global.fetch = realFetch;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    function mockFetchOnceJson(json: unknown): jest.Mock {
        const mock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => json,
        });
        global.fetch = mock as unknown as typeof fetch;

        return mock;
    }

    function mockFetchReject(err: Error): jest.Mock {
        const mock = jest.fn().mockRejectedValue(err);
        global.fetch = mock as unknown as typeof fetch;

        return mock;
    }

    describe('open-router live fetch', () => {
        it('parses pricing ($/token → $/M) and context length', async () => {
            const fetchMock = mockFetchOnceJson({
                data: [
                    {
                        id: 'openai/gpt-4o',
                        name: 'GPT-4o',
                        context_length: 128000,
                        pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125' },
                    },
                ],
            });

            const models = await getModelCatalog('open-router', { forceRefresh: true });

            expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models');
            expect(models).toHaveLength(1);

            const m = models[0];

            expect(m.id).toBe('openai/gpt-4o');
            expect(m.label).toBe('GPT-4o');
            expect(m.contextWindow).toBe(128000);
            expect(m.pricing?.inputPerM).toBeCloseTo(2.5, 4);
            expect(m.pricing?.outputPerM).toBeCloseTo(10, 4);
            expect(m.pricing?.cachedInputPerM).toBeCloseTo(1.25, 4);
        });

        it('writes results to disk cache', async () => {
            mockFetchOnceJson({
                data: [{ id: 'a/b', name: 'A/B', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' } }],
            });

            await getModelCatalog('open-router', { forceRefresh: true });

            const cacheFile = path.join(tmpHome, '.kra', 'model-catalog', 'open-router.json');

            expect(fs.existsSync(cacheFile)).toBe(true);

            const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { models: ModelInfo[]; fetchedAt: number };

            expect(parsed.models).toHaveLength(1);
            expect(parsed.models[0].id).toBe('a/b');
            expect(typeof parsed.fetchedAt).toBe('number');
        });
    });

    describe('cache behavior', () => {
        it('returns fresh cache without calling fetch', async () => {
            mockFetchOnceJson({ data: [{ id: 'first/model', name: 'first', context_length: 100, pricing: { prompt: '0', completion: '0' } }] });
            await getModelCatalog('open-router', { forceRefresh: true });

            const fetchMock = mockFetchOnceJson({ data: [] });
            const models = await getModelCatalog('open-router');

            expect(fetchMock).not.toHaveBeenCalled();
            expect(models[0].id).toBe('first/model');
        });

        it('forceRefresh bypasses fresh cache', async () => {
            mockFetchOnceJson({ data: [{ id: 'old/model', name: 'old', context_length: 100, pricing: { prompt: '0', completion: '0' } }] });
            await getModelCatalog('open-router', { forceRefresh: true });

            const fetchMock = mockFetchOnceJson({ data: [{ id: 'new/model', name: 'new', context_length: 100, pricing: { prompt: '0', completion: '0' } }] });
            const models = await getModelCatalog('open-router', { forceRefresh: true });

            expect(fetchMock).toHaveBeenCalled();
            expect(models[0].id).toBe('new/model');
        });
    });

    describe('fallback chain', () => {
        it('falls back to stale cache when live fetch fails', async () => {
            mockFetchOnceJson({ data: [{ id: 'cached/model', name: 'cached', context_length: 100, pricing: { prompt: '0', completion: '0' } }] });
            await getModelCatalog('open-router', { forceRefresh: true });

            mockFetchReject(new Error('network down'));
            const models = await getModelCatalog('open-router', { forceRefresh: true });

            expect(models[0].id).toBe('cached/model');
        });

        it('falls back to STATIC_FALLBACK_MODELS when live fails and no cache exists', async () => {
            mockFetchReject(new Error('network down'));
            const models = await getModelCatalog('open-router', { forceRefresh: true });

            expect(models.length).toBeGreaterThan(0);
            expect(models.some((m) => m.id === 'openai/gpt-4o-mini')).toBe(true);
        });

        it('falls back to static when fetch returns empty list', async () => {
            mockFetchOnceJson({ data: [] });
            const models = await getModelCatalog('open-router', { forceRefresh: true });

            expect(models.length).toBeGreaterThan(0);
        });
    });

    describe('deep-infra live fetch', () => {
        it('filters to text-generation and converts cents/token → $/M', async () => {
            mockFetchOnceJson([
                {
                    model_name: 'meta-llama/Llama-3-70B',
                    type: 'text-generation',
                    max_tokens: 8192,
                    pricing: { cents_per_input_token: 0.00006, cents_per_output_token: 0.00009 },
                },
                { model_name: 'should-skip', type: 'embedding' },
            ]);

            const models = await getModelCatalog('deep-infra', { forceRefresh: true });

            expect(models).toHaveLength(1);

            const m = models[0];

            expect(m.id).toBe('meta-llama/Llama-3-70B');
            expect(m.contextWindow).toBe(8192);
            expect(m.pricing?.inputPerM).toBeCloseTo(0.6, 4);
            expect(m.pricing?.outputPerM).toBeCloseTo(0.9, 4);
        });
    });

    describe('formatModelInfoForPicker', () => {
        it('renders ctx + pricing with cached input', () => {
            const out = formatModelInfoForPicker({
                id: 'x/y',
                label: 'x/y',
                contextWindow: 128000,
                pricing: { inputPerM: 0.5, outputPerM: 1.5, cachedInputPerM: 0.1 },
            });

            expect(out).toContain('x/y');
            expect(out).toContain('128k ctx');
            expect(out).toContain('$0.50/$1.50');
            expect(out).toContain('cached $0.10');
        });

        it('renders placeholders when ctx and pricing missing', () => {
            const out = formatModelInfoForPicker({ id: 'a', label: 'a', contextWindow: 0 });

            expect(out).toContain('? ctx');
            expect(out).toContain('? pricing');
        });
    });
});
