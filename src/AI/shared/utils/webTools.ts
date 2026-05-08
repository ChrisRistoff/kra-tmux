/**
 * Shared `web_fetch` / `web_search` implementations.
 *
 * Used by:
 *   - `src/AI/AIAgent/shared/utils/webMcpServer.ts` — wraps these as an MCP
 *     stdio server for BYOK agents.
 *   - `src/AI/AIChat/utils/promptModel.ts` — calls these in-process for
 *     OpenAI-style tool calling inside AIChat.
 *
 * DuckDuckGo's HTML endpoint (https://html.duckduckgo.com/html/) is used for
 * search; it can rate-limit, so a realistic browser User-Agent is sent.
 */

import * as cheerio from 'cheerio';
import { convert as htmlToTextLib } from 'html-to-text';

export const DEFAULT_MAX_LENGTH = 16_000;
export const HARD_MAX_LENGTH = 100_000;
export const DEFAULT_MAX_RESULTS = 5;
export const HARD_MAX_RESULTS = 15;
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const DEFAULT_GREP_CONTEXT = 2;
const MAX_GREP_CONTEXT = 10;
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** JSON Schema for web_fetch arguments. Reused by both MCP and OpenAI tool defs. */
export const WEB_FETCH_PARAMETERS = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: 'Absolute URL to fetch (http or https).',
        },
        max_length: {
            type: 'number',
            description: `Maximum number of characters to return from the (post-grep) body. Default ${DEFAULT_MAX_LENGTH}, hard cap ${HARD_MAX_LENGTH}.`,
        },
        start_index: {
            type: 'number',
            description: 'Character offset into the body to start returning from. Use with max_length to paginate long pages.',
        },
        query: {
            type: 'string',
            description: 'Optional case-insensitive regex. When set, only matching lines (with surrounding context) are returned instead of the head of the body. Use this to grep a long page without paginating through it.',
        },
        context: {
            type: 'number',
            description: `Lines of context around each query match (like ripgrep -C). Ignored unless query is set. Default ${DEFAULT_GREP_CONTEXT}, max ${MAX_GREP_CONTEXT}.`,
        },
        force_refresh: {
            type: 'boolean',
            description: 'Bypass the in-memory response cache and re-fetch from the network. Default false. Cache TTL is 15 minutes; stale hits are still returned but flagged in the output.',
        },
        mode: {
            type: 'string',
            enum: ['auto', 'crawl4ai', 'jina', 'direct'],
            description: "Fetch backend. 'auto' (default) tries the warm Crawl4AI worker first (handles JS, shadow DOM, dynamic content), then falls back to Jina Reader, then a raw GET. 'crawl4ai' forces the worker (Chromium); 'jina' forces r.jina.ai; 'direct' forces a raw HTTP fetch with HTML \u2192 text extraction.",
        },
    },
    required: ['url'],
    additionalProperties: false,
} as const;

export const WEB_SEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: 'Search query string.',
        },
        max_results: {
            type: 'number',
            description: `Maximum number of results to return. Default ${DEFAULT_MAX_RESULTS}, hard cap ${HARD_MAX_RESULTS}.`,
        },
    },
    required: ['query'],
    additionalProperties: false,
} as const;

export const WEB_FETCH_DESCRIPTION = [
    'Fetch a URL over HTTPS/HTTP and return the response body as text.',
    'HTML responses are stripped of nav/footer/scripts/styles so the model',
    `sees mostly main content. Default cap ${DEFAULT_MAX_LENGTH} chars (hard cap ${HARD_MAX_LENGTH}).`,
    'Responses are cached in-memory for 15 minutes; repeat calls are free unless force_refresh=true.',
    'For long pages, prefer `query` (regex grep with context lines) over paginating with `start_index`+`max_length`.',
].join(' ');

export const WEB_SEARCH_DESCRIPTION = [
    'Run a web search via DuckDuckGo and return a ranked list of results',
    '(title, URL, snippet) as markdown. Best for finding pages to follow up',
    'on with `web_fetch`. May rate-limit if called repeatedly in quick',
    'succession.',
].join(' ');

export type WebFetchMode = 'auto' | 'crawl4ai' | 'jina' | 'direct';

export interface WebFetchArgs {
    url: string;
    max_length?: number;
    start_index?: number;
    query?: string;
    context?: number;
    force_refresh?: boolean;
    mode?: WebFetchMode;
}

interface CacheEntry {
    url: string;
    status: number;
    statusText: string;
    contentType: string;
    body: string;
    via: string;
    fetchedAt: number;
}

const responseCache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry | undefined {
    const entry = responseCache.get(url);
    if (!entry) {
        return undefined;
    }
    responseCache.delete(url);
    responseCache.set(url, entry);

    return entry;
}

function cacheSet(url: string, entry: CacheEntry): void {
    responseCache.delete(url);
    responseCache.set(url, entry);
    while (responseCache.size > CACHE_MAX_ENTRIES) {
        const oldest = responseCache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        responseCache.delete(oldest);
    }
}

/** Test-only. Clears the in-memory response cache. */
export function _clearWebFetchCache(): void {
    responseCache.clear();
}

export interface WebSearchArgs {
    query: string;
    max_results?: number;
}

export interface WebToolResult {
    output: string;
    isError: boolean;
}

function htmlToText(html: string): string {
    return htmlToTextLib(html, {
        wordwrap: false,
        selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
            { selector: 'noscript', format: 'skip' },
        ],
    });
}

const CHROME_SELECTORS = [
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'button',
    'svg',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="search"]',
    '[role="complementary"]',
    '[aria-hidden="true"]',
    '.nav',
    '.navbar',
    '.menu',
    '.sidebar',
    '.header',
    '.footer',
    '.cookie',
    '.cookies',
    '.consent',
    '.advertisement',
    '.ads',
    '.ad',
    '.banner',
    '.breadcrumb',
    '.breadcrumbs',
    '.social',
    '.share',
    '.newsletter',
    '.subscribe',
    '.related',
    '.recommended',
    '.popup',
    '.modal',
    '.toolbar',
    '#nav',
    '#header',
    '#footer',
    '#sidebar',
    '#menu',
].join(', ');

function extractMainContent(html: string): string {
    const $ = cheerio.load(html);

    $(CHROME_SELECTORS).remove();

    const main = $('main, article, [role="main"], #main, #content, .content, .main').first();
    const root = main.length > 0 ? main : $('body');

    return root.html() ?? html;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}


async function fetchDirect(url: string): Promise<{ ok: boolean; status: number; statusText: string; finalUrl: string; contentType: string; body: string }> {
    const response = await fetchWithTimeout(url, {
        redirect: 'follow',
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    const body = contentType.includes('html') ? htmlToText(extractMainContent(raw)) : raw;

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.url,
        contentType,
        body,
    };
}

async function fetchViaJina(url: string): Promise<{ ok: boolean; body: string; status: number; statusText: string }> {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetchWithTimeout(jinaUrl, {
        redirect: 'follow',
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/plain, text/markdown, */*',
            'X-Return-Format': 'markdown',
        },
    });
    const body = await response.text();

    return { ok: response.ok, body, status: response.status, statusText: response.statusText };
}


interface BuildOutputParts {
    url: string;
    status: number;
    statusText: string;
    contentType: string;
    body: string;
    maxLength: number;
    startIndex: number;
    via?: string | undefined;
    cache?: { ageMs: number; stale: boolean } | undefined;
    matches?: { count: number; matchedLineCount: number } | undefined;
}

function buildOutput(parts: BuildOutputParts): string {
    const safeStart = Math.max(0, Math.min(parts.startIndex, parts.body.length));
    const slice = parts.body.slice(safeStart, safeStart + parts.maxLength);
    const end = safeStart + slice.length;
    const truncated = end < parts.body.length || safeStart > 0;
    const ageMin = parts.cache ? Math.max(1, Math.round(parts.cache.ageMs / 60_000)) : 0;
    const cacheLine = parts.cache
        ? `Cache: ${parts.cache.stale ? 'stale' : 'hit'} (${ageMin}m old)${parts.cache.stale ? ' — pass force_refresh=true for the latest' : ''}`
        : '';
    const matchLine = parts.matches
        ? `Matches: ${parts.matches.count} across ${parts.matches.matchedLineCount} lines`
        : '';
    const rangeLine = truncated
        ? `Range: chars ${safeStart}–${end} of ${parts.body.length}${end < parts.body.length ? ' (use start_index to continue)' : ''}`
        : '';

    return [
        `URL: ${parts.url}`,
        `Status: ${parts.status} ${parts.statusText}`,
        `Content-Type: ${parts.contentType || '(unknown)'}`,
        parts.via ? `Fetched-Via: ${parts.via}` : '',
        cacheLine,
        matchLine,
        rangeLine,
        '',
        slice,
    ]
        .filter(Boolean)
        .join('\n');
}

function applyQueryFilter(
    body: string,
    query: string,
    context: number
): { body: string; matches: number; matchedLineCount: number } {
    let regex: RegExp;
    try {
        regex = new RegExp(query, 'i');
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);

        return {
            body: `(invalid query regex /${query}/: ${reason})`,
            matches: 0,
            matchedLineCount: 0,
        };
    }
    const lines = body.split('\n');
    const includedIdx = new Set<number>();
    let matches = 0;
    for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
            matches++;
            const lo = Math.max(0, i - context);
            const hi = Math.min(lines.length - 1, i + context);
            for (let j = lo; j <= hi; j++) {
                includedIdx.add(j);
            }
        }
    }
    if (matches === 0) {
        return { body: `(no matches for /${query}/i)`, matches: 0, matchedLineCount: 0 };
    }
    const sorted = [...includedIdx].sort((a, b) => a - b);
    const chunks: string[] = [];
    let current: string[] = [];
    let prev = -2;
    for (const idx of sorted) {
        if (idx !== prev + 1 && current.length > 0) {
            chunks.push(current.join('\n'));
            current = [];
        }
        current.push(`${idx + 1}: ${lines[idx]}`);
        prev = idx;
    }
    if (current.length > 0) {
        chunks.push(current.join('\n'));
    }

    return { body: chunks.join('\n--\n'), matches, matchedLineCount: includedIdx.size };
}

function statusTextFor(code: number): string {
    const map: Record<number, string> = {
        200: 'OK', 201: 'Created', 204: 'No Content',
        301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
        400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
        404: 'Not Found', 408: 'Request Timeout', 410: 'Gone', 429: 'Too Many Requests',
        500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    if (map[code]) return map[code];
    if (code >= 200 && code < 300) return 'OK';
    if (code >= 300 && code < 400) return 'Redirect';
    if (code >= 400 && code < 500) return 'Client Error';
    if (code >= 500) return 'Server Error';
    return '';
}


async function fetchViaCrawl4ai(
    url: string,
    crawlerMode: 'auto' | 'http' | 'browser' | undefined,
): Promise<{ entry: CacheEntry } | { error: string }> {
    // Lazy require so a missing venv / unrelated error doesn't blow up the
    // whole module on import. fetchWorker handles its own "not installed"
    // detection but we still want to swallow any unexpected throws.
    try {
        const { getFetchWorker } = await import('@/AI/AIAgent/shared/web/fetchWorker');
        const worker = getFetchWorker();
        const opts = crawlerMode ? { mode: crawlerMode } : {};
        const result = await worker.fetch(url, opts);
        if (!result.markdown.trim()) {
            return { error: 'crawl4ai returned empty markdown' };
        }
        const status = result.status ?? 200;
        return {
            entry: {
                url,
                status,
                statusText: statusTextFor(status),
                contentType: `text/markdown (via Crawl4AI ${result.mode}${result.coldStart ? ' cold' : ' warm'})`,
                body: result.markdown.slice(0, HARD_MAX_LENGTH),
                via: result.coldStart ? 'crawl4ai-cold' : 'crawl4ai-warm',
                fetchedAt: Date.now(),
            },
        };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

async function fetchAndBuildEntry(
    url: string,
    mode: WebFetchMode,
): Promise<{ entry?: CacheEntry; error?: string }> {
    const errors: string[] = [];

    if (mode === 'auto' || mode === 'crawl4ai') {
        const c = await fetchViaCrawl4ai(url, mode === 'crawl4ai' ? 'browser' : 'auto');
        if ('entry' in c) return { entry: c.entry };
        errors.push(`crawl4ai: ${c.error}`);
        if (mode === 'crawl4ai') {
            return { error: `Fetch failed via crawl4ai: ${c.error}` };
        }
    }

    let jinaError: string | null = null;

    if (mode === 'auto' || mode === 'jina') try {
        const jina = await fetchViaJina(url);
        if (jina.ok && jina.body.trim().length >= 200) {
            return {
                entry: {
                    url,
                    status: jina.status,
                    statusText: jina.statusText,
                    contentType: 'text/markdown (via Jina Reader)',
                    body: jina.body.slice(0, HARD_MAX_LENGTH),
                    via: 'r.jina.ai',
                    fetchedAt: Date.now(),
                },
            };
        }
    } catch (error) {
        jinaError = error instanceof Error ? error.message : String(error);
        errors.push(`jina: ${jinaError}`);
    }

    if (mode === 'jina') {
        return { error: `Fetch failed via jina: ${jinaError ?? 'no usable content'}` };
    }

    try {
        const direct = await fetchDirect(url);

        return {
            entry: {
                url: direct.finalUrl,
                status: direct.status,
                statusText: direct.statusText,
                contentType: direct.contentType,
                body: (direct.body || '(empty body; Jina Reader fallback also failed)').slice(0, HARD_MAX_LENGTH),
                via: 'direct',
                fetchedAt: Date.now(),
            },
        };
    } catch (error) {
        const directError = error instanceof Error ? error.message : String(error);
        errors.push(`direct: ${directError}`);

        return {
            error: `Fetch failed (${errors.join('; ')})`,
        };
    }
}

export async function runWebFetch(args: WebFetchArgs): Promise<WebToolResult> {
    if (!/^https?:\/\//i.test(args.url)) {
        return { output: `Invalid URL (must be http/https): ${args.url}`, isError: true };
    }

    const maxLength = Math.min(args.max_length ?? DEFAULT_MAX_LENGTH, HARD_MAX_LENGTH);
    const startIndex = Math.max(0, args.start_index ?? 0);
    const context = Math.max(0, Math.min(args.context ?? DEFAULT_GREP_CONTEXT, MAX_GREP_CONTEXT));
    const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined;

    let entry: CacheEntry | undefined;
    let cacheMeta: { ageMs: number; stale: boolean } | undefined;

    const mode: WebFetchMode = args.mode ?? 'auto';
    const cacheKey = `${mode}|${args.url}`;

    if (!args.force_refresh) {
        const hit = cacheGet(cacheKey);
        if (hit) {
            entry = hit;
            const ageMs = Date.now() - hit.fetchedAt;
            cacheMeta = { ageMs, stale: ageMs > CACHE_TTL_MS };
        }
    }

    if (!entry) {
        const fetched = await fetchAndBuildEntry(args.url, mode);
        if (fetched.error || !fetched.entry) {
            return { output: fetched.error ?? 'Unknown fetch error', isError: true };
        }
        entry = fetched.entry;
        cacheSet(cacheKey, entry);
    }

    let body = entry.body;
    let matchInfo: { count: number; matchedLineCount: number } | undefined;

    if (query) {
        const grepped = applyQueryFilter(body, query, context);
        body = grepped.body;
        matchInfo = { count: grepped.matches, matchedLineCount: grepped.matchedLineCount };
    }

    return {
        output: buildOutput({
            url: entry.url,
            status: entry.status,
            statusText: entry.statusText,
            contentType: entry.contentType,
            body,
            maxLength,
            startIndex,
            via: entry.via,
            cache: cacheMeta,
            matches: matchInfo,
        }),
        isError: entry.status >= 400,
    };
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface FetchedPage {
    url: string;
    title: string;
    body: string;
    contentType: string;
    via: string;
    fetchedAt: number;
    status: number;
}

/**
 * Lower-level fetch that returns the raw markdown body without the header /
 * pagination scaffolding `runWebFetch` adds for LLM display. Used by the
 * `investigate_web` sub-agent's `web_scrape_and_index` tool to feed pages
 * into the chunker + embedder.
 *
 * Reuses the same cache + `fetchAndBuildEntry` pipeline as `runWebFetch` so
 * concurrent calls share fetched bodies.
 */
export async function fetchPageMarkdown(
    url: string,
    mode: WebFetchMode = 'auto',
): Promise<{ page?: FetchedPage; error?: string }> {
    if (!/^https?:\/\//i.test(url)) {
        return { error: `Invalid URL (must be http/https): ${url}` };
    }

    const cacheKey = `${mode}|${url}`;
    let entry = cacheGet(cacheKey);

    if (!entry) {
        const fetched = await fetchAndBuildEntry(url, mode);
        if (fetched.error || !fetched.entry) {
            return { error: fetched.error ?? 'Unknown fetch error' };
        }
        entry = fetched.entry;
        cacheSet(cacheKey, entry);
    }

    if (entry.status >= 400) {
        return { error: `HTTP ${entry.status} ${entry.statusText} for ${url}` };
    }

    return {
        page: {
            url: entry.url,
            title: extractMarkdownTitle(entry.body) ?? deriveTitleFromUrl(entry.url),
            body: entry.body,
            contentType: entry.contentType,
            via: entry.via,
            fetchedAt: entry.fetchedAt,
            status: entry.status,
        },
    };
}

function extractMarkdownTitle(markdown: string): string | undefined {
    // First non-empty `# ` line, looking only at the first ~40 lines so we don't
    // misidentify a deep heading as the page title.
    const lines = markdown.split('\n', 40);
    for (const line of lines) {
        const m = /^\s*#\s+(.+?)\s*$/.exec(line);
        if (m) return m[1];
    }

    return undefined;
}

function deriveTitleFromUrl(url: string): string {
    try {
        const u = new URL(url);

        return `${u.hostname}${u.pathname}`;
    } catch {
        return url;
    }
}

/**
 * Structured search that returns `SearchResult[]` instead of a formatted
 * string. Tries Jina first if `JINA_API` is set, falls back to DuckDuckGo
 * lite. Used by the `investigate_web` sub-agent's `web_search` tool so the
 * model gets a clean JSON list of `{title, url, snippet}` to triage.
 */
export async function searchPagesStructured(
    query: string,
    limit: number = DEFAULT_MAX_RESULTS,
): Promise<{ results: SearchResult[]; error?: string }> {
    const trimmed = query.trim();
    if (!trimmed) return { results: [], error: 'Missing required argument: query' };

    const cap = Math.min(limit, HARD_MAX_RESULTS);

    if (process.env.JINA_API) {
        const jina = await searchJinaStructured(trimmed, cap);
        if (jina.results.length > 0) return jina;
    }

    return await searchDuckDuckGoLiteStructured(trimmed, cap);
}

async function searchJinaStructured(
    query: string,
    limit: number,
): Promise<{ results: SearchResult[]; error?: string }> {
    const apiKey = process.env.JINA_API;
    if (!apiKey) return { results: [], error: 'JINA_API not set' };

    try {
        const response = await fetchWithTimeout(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'X-Respond-With': 'no-content',
            },
        });

        if (!response.ok) {
            return { results: [], error: `Jina HTTP ${response.status} ${response.statusText}` };
        }

        const json = await response.json() as JinaSearchResponse;
        const items = Array.isArray(json.data) ? json.data : [];
        const results = items.slice(0, limit).map((item) => ({
            title: (item.title ?? '').trim(),
            url: (item.url ?? '').trim(),
            snippet: (item.description ?? item.content ?? '').trim(),
        })).filter((r) => r.title && r.url);

        return { results };
    } catch (error) {
        return {
            results: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function searchDuckDuckGoLiteStructured(
    query: string,
    limit: number,
): Promise<{ results: SearchResult[]; error?: string }> {
    try {
        const body = new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
        const response = await fetchWithTimeout('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            body,
        });

        if (!response.ok) {
            return { results: [], error: `DuckDuckGo HTTP ${response.status} ${response.statusText}` };
        }

        const html = await response.text();
        if (/anomaly|unusual traffic|blocked/i.test(html) && !/result-link/i.test(html)) {
            return { results: [], error: 'DuckDuckGo rate-limited the request. Retry in a minute.' };
        }

        return { results: parseDuckDuckGoLiteHtml(html, limit) };
    } catch (error) {
        return {
            results: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}


function formatResults(query: string, results: SearchResult[]): string {
    if (results.length === 0) {
        return `No results found for: ${query}`;
    }

    const lines = [`Search results for: ${query}`, ''];

    results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);

        if (r.snippet) {
            lines.push(`   ${r.snippet}`);
        }

        lines.push('');
    });

    return lines.join('\n').trim();
}

function parseDuckDuckGoLiteHtml(html: string, limit: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    const links = $('a.result-link');
    links.each((_, el) => {
        if (results.length >= limit) {
            return false;
        }

        const $a = $(el);
        const title = $a.text().trim();
        let url = ($a.attr('href') ?? '').trim();

        const redirectMatch = /[?&]uddg=([^&]+)/.exec(url);
        if (redirectMatch?.[1]) {
            try {
                url = decodeURIComponent(redirectMatch[1]);
            } catch {
                // keep raw url on decode failure
            }
        }

        const snippet = $a.closest('tr').next('tr').find('td.result-snippet').text().trim();

        if (title && url) {
            results.push({ title, url, snippet });
        }

        return;
    });

    return results;
}

interface JinaSearchResult {
    title?: string;
    url?: string;
    description?: string;
    content?: string;
}

interface JinaSearchResponse {
    code?: number;
    data?: JinaSearchResult[];
    message?: string;
}

async function searchJina(query: string, limit: number): Promise<WebToolResult> {
    const apiKey = process.env.JINA_API;

    if (!apiKey) {
        return { output: 'Jina search skipped: JINA_API env var not set', isError: true };
    }

    try {
        const response = await fetchWithTimeout(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'X-Respond-With': 'no-content',
            },
        });

        if (!response.ok) {
            const text = await response.text();

            return {
                output: `Jina search failed: HTTP ${response.status} ${response.statusText} ${text.slice(0, 300)}`,
                isError: true,
            };
        }

        const json = await response.json() as JinaSearchResponse;
        const items = Array.isArray(json.data) ? json.data : [];

        const results: SearchResult[] = items.slice(0, limit).map((item) => ({
            title: (item.title ?? '').trim(),
            url: (item.url ?? '').trim(),
            snippet: (item.description ?? item.content ?? '').trim(),
        })).filter((r) => r.title && r.url);

        if (results.length === 0) {
            return { output: 'Jina search returned no results', isError: true };
        }

        return { output: formatResults(query, results), isError: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { output: `Jina search failed: ${message}`, isError: true };
    }
}

async function searchDuckDuckGoLite(query: string, limit: number): Promise<WebToolResult> {
    try {
        const body = new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
        const response = await fetchWithTimeout('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            body,
        });

        if (!response.ok) {
            return {
                output: `Lite search request failed: HTTP ${response.status} ${response.statusText}`,
                isError: true,
            };
        }

        const html = await response.text();

        if (/anomaly|unusual traffic|blocked/i.test(html) && !/result-link/i.test(html)) {
            return {
                output: 'DuckDuckGo (lite) also rate-limited the request. Retry in a minute.',
                isError: true,
            };
        }

        const results = parseDuckDuckGoLiteHtml(html, limit);

        return { output: formatResults(query, results), isError: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { output: `Lite search failed: ${message}`, isError: true };
    }
}

export async function runWebSearch(args: WebSearchArgs): Promise<WebToolResult> {
    const query = args.query.trim();

    if (!query) {
        return { output: 'Missing required argument: query', isError: true };
    }

    const limit = Math.min(args.max_results ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);

    if (process.env.JINA_API) {
        const jina = await searchJina(query, limit);
        if (!jina.isError) {
            return jina;
        }
    }

    return await searchDuckDuckGoLite(query, limit);
}
