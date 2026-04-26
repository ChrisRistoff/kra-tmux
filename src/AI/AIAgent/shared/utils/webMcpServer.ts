#!/usr/bin/env node
/**
 * kra-web MCP server — exposes `web_fetch` and `web_search` to BYOK agents.
 *
 * Mirrors the JSON-RPC stdio pattern used by bashMcpServer.ts so we have no
 * extra runtime dependency. Uses Node 18+ built-in `fetch`.
 *
 *   web_fetch(url, max_length?)        → fetches a URL and returns text
 *                                        (HTML stripped to plain text).
 *   web_search(query, max_results?)    → scrapes DuckDuckGo's HTML endpoint
 *                                        and returns a markdown list of hits.
 *
 * DuckDuckGo's HTML endpoint (https://html.duckduckgo.com/html/) is more
 * lenient than the JSON instant-answer API used by `duck-duck-scrape`, but it
 * can still rate-limit. We send a realistic browser User-Agent to reduce that.
 */

import readline from 'readline';
import * as cheerio from 'cheerio';
import { convert as htmlToTextLib } from 'html-to-text';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string | null;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string };
}

function send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
}

function sendResult(id: number | string | null, result: unknown): void {
    send({ jsonrpc: '2.0', id: id ?? null, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
    send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

const DEFAULT_MAX_LENGTH = 8_000;
const HARD_MAX_LENGTH = 50_000;
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 15;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const WEB_FETCH_TOOL = {
    name: 'web_fetch',
    description: [
        'Fetch a URL over HTTPS/HTTP and return the response body as text.',
        'HTML responses are stripped of nav/footer/scripts/styles so the model',
        `sees mostly main content. Default cap ${DEFAULT_MAX_LENGTH} chars (hard cap ${HARD_MAX_LENGTH});`,
        'increase max_length only when you need more.',
    ].join(' '),
    inputSchema: {
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
    },
};

const WEB_SEARCH_TOOL = {
    name: 'web_search',
    description: [
        'Run a web search via DuckDuckGo and return a ranked list of results',
        '(title, URL, snippet) as markdown. Best for finding pages to follow up',
        'on with `web_fetch`. May rate-limit if called repeatedly in quick',
        'succession.',
    ].join(' '),
    inputSchema: {
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
    },
};

interface WebFetchArgs {
    url: string;
    max_length?: number;
}

interface WebSearchArgs {
    query: string;
    max_results?: number;
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

async function runWebFetch(args: WebFetchArgs): Promise<{ output: string; isError: boolean }> {
    if (!/^https?:\/\//i.test(args.url)) {
        return { output: `Invalid URL (must be http/https): ${args.url}`, isError: true };
    }

    const maxLength = Math.min(args.max_length ?? DEFAULT_MAX_LENGTH, HARD_MAX_LENGTH);

    try {
        const response = await fetchWithTimeout(args.url, {
            redirect: 'follow',
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        const contentType = response.headers.get('content-type') ?? '';
        const raw = await response.text();
        const body = contentType.includes('html') ? htmlToText(extractMainContent(raw)) : raw;
        const truncated = body.length > maxLength;
        const output = [
            `URL: ${response.url}`,
            `Status: ${response.status} ${response.statusText}`,
            `Content-Type: ${contentType || '(unknown)'}`,
            truncated ? `Truncated: showing first ${maxLength} of ${body.length} chars` : '',
            '',
            body.slice(0, maxLength),
        ]
            .filter(Boolean)
            .join('\n');

        return { output, isError: !response.ok };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { output: `Fetch failed: ${message}`, isError: true };
    }
}

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('div.result, div.web-result, .results_links').each((_, el) => {
        if (results.length >= limit) {
            return false;
        }

        const $el = $(el);
        const $a = $el.find('a.result__a').first();
        const title = $a.text().trim();
        let url = ($a.attr('href') ?? '').trim();
        const snippet = $el.find('.result__snippet').text().trim();

        const redirectMatch = /[?&]uddg=([^&]+)/.exec(url);

        if (redirectMatch?.[1]) {
            try {
                url = decodeURIComponent(redirectMatch[1]);
            } catch {
                // keep original
            }
        }

        if (url.startsWith('//')) {
            url = 'https:' + url;
        }

        if (!url || !title) {
            return;
        }

        results.push({ title, url, snippet });

        return;
    });

    return results;
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

async function runWebSearch(args: WebSearchArgs): Promise<{ output: string; isError: boolean }> {
    const query = args.query.trim();

    if (!query) {
        return { output: 'Missing required argument: query', isError: true };
    }

    const limit = Math.min(args.max_results ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);

    try {
        const body = new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
        const response = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
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
                output: `Search request failed: HTTP ${response.status} ${response.statusText}`,
                isError: true,
            };
        }

        const html = await response.text();

        if (/anomaly|unusual traffic|blocked/i.test(html) && !/result__a/i.test(html)) {
            return {
                output:
                    'DuckDuckGo rate-limited the request. Retry in a minute, or fall back to ' +
                    '`bash` + curl on a specific URL via `web_fetch`.',
                isError: true,
            };
        }

        const results = parseDuckDuckGoHtml(html, limit);

        return { output: formatResults(query, results), isError: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { output: `Search failed: ${message}`, isError: true };
    }
}

const TOOLS = [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
        return;
    }

    let request: JsonRpcRequest;

    try {
        request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
        sendError(null, -32700, 'Parse error');

        return;
    }

    const id = request.id ?? null;

    void (async (): Promise<void> => {
        try {
            switch (request.method) {
                case 'initialize':
                    sendResult(id, {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'kra-web', version: '1.0.0' },
                    });

                    return;

                case 'notifications/initialized':
                    return;

                case 'tools/list':
                    sendResult(id, { tools: TOOLS });

                    return;

                case 'tools/call': {
                    const params = (request.params ?? {}) as {
                        name?: string;
                        arguments?: WebFetchArgs & WebSearchArgs;
                    };
                    const args: Partial<WebFetchArgs & WebSearchArgs> = params.arguments ?? {};

                    if (params.name === 'web_fetch') {
                        if (typeof args.url !== 'string') {
                            sendError(id, -32602, 'Missing required argument: url');

                            return;
                        }

                        const { output, isError } = await runWebFetch({
                            url: args.url,
                            ...(args.max_length !== undefined ? { max_length: args.max_length } : {}),
                        });

                        sendResult(id, {
                            content: [{ type: 'text', text: output }],
                            isError,
                        });

                        return;
                    }

                    if (params.name === 'web_search') {
                        if (typeof args.query !== 'string') {
                            sendError(id, -32602, 'Missing required argument: query');

                            return;
                        }

                        const { output, isError } = await runWebSearch({
                            query: args.query,
                            ...(args.max_results !== undefined ? { max_results: args.max_results } : {}),
                        });

                        sendResult(id, {
                            content: [{ type: 'text', text: output }],
                            isError,
                        });

                        return;
                    }

                    sendError(id, -32601, `Unknown tool: ${params.name ?? '(none)'}`);

                    return;
                }

                default:
                    sendError(id, -32601, `Method not found: ${request.method}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendError(id, -32603, `Internal error: ${message}`);
        }
    })();
});

rl.on('close', () => {
    process.exit(0);
});
