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

export const DEFAULT_MAX_LENGTH = 8_000;
export const HARD_MAX_LENGTH = 50_000;
export const DEFAULT_MAX_RESULTS = 5;
export const HARD_MAX_RESULTS = 15;
const FETCH_TIMEOUT_MS = 20_000;
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
            description: `Maximum number of characters to return. Default ${DEFAULT_MAX_LENGTH}, hard cap ${HARD_MAX_LENGTH}.`,
        },
    },
    required: ['url'],
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
} as const;

export const WEB_FETCH_DESCRIPTION = [
    'Fetch a URL over HTTPS/HTTP and return the response body as text.',
    'HTML responses are stripped of nav/footer/scripts/styles so the model',
    `sees mostly main content. Default cap ${DEFAULT_MAX_LENGTH} chars (hard cap ${HARD_MAX_LENGTH});`,
    'increase max_length only when you need more.',
].join(' ');

export const WEB_SEARCH_DESCRIPTION = [
    'Run a web search via DuckDuckGo and return a ranked list of results',
    '(title, URL, snippet) as markdown. Best for finding pages to follow up',
    'on with `web_fetch`. May rate-limit if called repeatedly in quick',
    'succession.',
].join(' ');

export interface WebFetchArgs {
    url: string;
    max_length?: number;
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


function buildOutput(parts: { url: string; status: number; statusText: string; contentType: string; body: string; maxLength: number; via?: string }): string {
    const truncated = parts.body.length > parts.maxLength;

    return [
        `URL: ${parts.url}`,
        `Status: ${parts.status} ${parts.statusText}`,
        `Content-Type: ${parts.contentType || '(unknown)'}`,
        parts.via ? `Fetched-Via: ${parts.via}` : '',
        truncated ? `Truncated: showing first ${parts.maxLength} of ${parts.body.length} chars` : '',
        '',
        parts.body.slice(0, parts.maxLength),
    ]
        .filter(Boolean)
        .join('\n');
}

export async function runWebFetch(args: WebFetchArgs): Promise<WebToolResult> {
    if (!/^https?:\/\//i.test(args.url)) {
        return { output: `Invalid URL (must be http/https): ${args.url}`, isError: true };
    }

    const maxLength = Math.min(args.max_length ?? DEFAULT_MAX_LENGTH, HARD_MAX_LENGTH);

    let jinaError: string | null = null;

    try {
        const jina = await fetchViaJina(args.url);
        if (jina.ok && jina.body.trim().length >= 200) {
            return {
                output: buildOutput({
                    url: args.url,
                    status: jina.status,
                    statusText: jina.statusText,
                    contentType: 'text/markdown (via Jina Reader)',
                    body: jina.body,
                    maxLength,
                    via: 'r.jina.ai',
                }),
                isError: false,
            };
        }
    } catch (error) {
        jinaError = error instanceof Error ? error.message : String(error);
    }

    try {
        const direct = await fetchDirect(args.url);

        return {
            output: buildOutput({
                url: direct.finalUrl,
                status: direct.status,
                statusText: direct.statusText,
                contentType: direct.contentType,
                body: direct.body || '(empty body; Jina Reader fallback also failed)',
                maxLength,
                via: 'direct',
            }),
            isError: !direct.ok,
        };
    } catch (error) {
        const directError = error instanceof Error ? error.message : String(error);

        return {
            output: `Fetch failed: Jina Reader (${jinaError ?? 'no usable content'}) and direct fetch (${directError}) both failed.`,
            isError: true,
        };
    }
}

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
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
