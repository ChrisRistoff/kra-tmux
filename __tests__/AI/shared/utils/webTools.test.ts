import { runWebFetch, _clearWebFetchCache } from '@/AI/shared/utils/webTools';

// All tests in this file exercise the Jina/direct fallback path. Stub out
// crawl4ai so they don't try to spawn the real Python worker (which exists
// on dev machines and would hang the test).
jest.mock('@/AI/AIAgent/commands/docsSetup', () => ({
    isCrawl4aiInstalled: () => false,
}));

describe('runWebFetch', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        _clearWebFetchCache();
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    function mockJina(body: string, ok = true): void {
        fetchMock.mockResolvedValueOnce({
            ok,
            status: ok ? 200 : 500,
            statusText: ok ? 'OK' : 'Server Error',
            url: 'https://r.jina.ai/x',
            text: async () => body,
            headers: { get: (): string => 'text/markdown' },
        });
    }

    function mockJinaThenDirect(jinaBody: string, directBody: string, directContentType = 'text/plain'): void {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://r.jina.ai/x',
            text: async () => jinaBody,
            headers: { get: (): string => 'text/markdown' },
        });
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            url: 'https://example.test/page',
            text: async () => directBody,
            headers: { get: (k: string): string => (k.toLowerCase() === 'content-type' ? directContentType : '') },
        });
    }

    it('rejects non-http URLs without fetching', async () => {
        const res = await runWebFetch({ url: 'file:///etc/passwd' });
        expect(res.isError).toBe(true);
        expect(res.output).toMatch(/Invalid URL/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the body and basic metadata on a fresh fetch', async () => {
        mockJina('A'.repeat(500));
        const res = await runWebFetch({ url: 'https://example.test/page' });
        expect(res.isError).toBe(false);
        expect(res.output).toContain('URL: https://example.test/page');
        expect(res.output).toContain('Status: 200 OK');
        expect(res.output).toContain('A'.repeat(100));
    });

    it('serves the second call from cache and annotates Cache:', async () => {
        mockJina('B'.repeat(500));
        await runWebFetch({ url: 'https://example.test/page' });
        const second = await runWebFetch({ url: 'https://example.test/page' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second.output).toMatch(/Cache: hit/);
    });

    it('bypasses cache when force_refresh is true', async () => {
        mockJina('C'.repeat(500));
        mockJina('D'.repeat(500));
        await runWebFetch({ url: 'https://example.test/page' });
        const second = await runWebFetch({ url: 'https://example.test/page', force_refresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(second.output).not.toMatch(/Cache: hit/);
        expect(second.output).toContain('D'.repeat(100));
    });

    it('marks stale cache entries as stale', async () => {
        const realNow = Date.now;
        try {
            const t0 = 1_700_000_000_000;
            Date.now = jest.fn(() => t0);
            mockJina('E'.repeat(500));
            await runWebFetch({ url: 'https://example.test/page' });
            Date.now = jest.fn(() => t0 + 20 * 60 * 1000);
            const second = await runWebFetch({ url: 'https://example.test/page' });
            expect(second.output).toMatch(/Cache: stale/);
            expect(second.output).toMatch(/force_refresh=true/);
        } finally {
            Date.now = realNow;
        }
    });

    it('paginates with start_index and reports the range', async () => {
        const body = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
        mockJina(body);
        const res = await runWebFetch({ url: 'https://example.test/page', start_index: 100, max_length: 50 });
        expect(res.output).toMatch(/Range: chars 100\u2013150 of \d+/);
        const sliceLine = res.output.split('\n').slice(-1)[0];
        expect(body.slice(100, 150)).toContain(sliceLine.slice(0, 5));
    });

    it('greps the body when query is set and reports match counts', async () => {
        const body = [
            'unrelated line one',
            'unrelated line two',
            'this line has TARGET in it',
            'context after target',
            'more unrelated noise',
            'and another TARGET hit here',
            'trailing context',
            'padding '.repeat(40),
        ].join('\n');
        mockJina(body);
        const res = await runWebFetch({ url: 'https://example.test/page', query: 'target', context: 1 });
        expect(res.output).toMatch(/Matches: 3 across \d+ lines/);
        expect(res.output).toContain('TARGET');
        expect(res.output).not.toContain('unrelated line one');
    });

    it('returns a no-match notice when query matches nothing', async () => {
        mockJina('completely unrelated content here. ' + 'pad '.repeat(80));
        const res = await runWebFetch({ url: 'https://example.test/page', query: 'zzz_nope' });
        expect(res.output).toContain('(no matches for /zzz_nope/i)');
        expect(res.output).toMatch(/Matches: 0 across 0 lines/);
    });

    it('handles invalid regex gracefully', async () => {
        mockJina('hello world. ' + 'pad '.repeat(80));
        const res = await runWebFetch({ url: 'https://example.test/page', query: '[unterminated' });
        expect(res.output).toContain('(invalid query regex /[unterminated/');
        expect(res.isError).toBe(false);
    });

    it('falls back to direct fetch when Jina returns short content', async () => {
        mockJinaThenDirect('short', 'D'.repeat(800));
        const res = await runWebFetch({ url: 'https://example.test/page' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.output).toContain('Fetched-Via: direct');
        expect(res.output).toContain('D'.repeat(100));
    });
});
