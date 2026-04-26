#!/usr/bin/env node
/**
 * kra-memory MCP server — exposes the Phase 1 memory tools to agents.
 *
 * Mirrors the JSON-RPC stdio pattern used by `bashMcpServer.ts` and
 * `webMcpServer.ts`. All operations resolve `<repo>` from
 * `process.env.WORKING_DIR` (set by the spawning provider) so memory is
 * scoped per agent workspace.
 */

import readline from 'readline';
import { editMemory, recall, remember, updateMemory } from '../memory/notes';
import { semanticSearch } from '../memory/search';
import { MEMORY_KINDS, MEMORY_STATUSES } from '../memory/types';

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

const REMEMBER_TOOL = {
    name: 'remember',
    description: [
        'Persist a long-term note about this repo so the next session has it.',
        'Use for non-obvious bug fixes, gotchas, design decisions, investigation results,',
        'or to PARK an idea you want to revisit later (kind="revisit" → stays open until you call update_memory).',
        'Include enough detail in body that a future session can act on it without re-investigating.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Category of memory entry. Use "revisit" to park an idea for later (filterable via recall(kind="revisit", status="open")).' },
            title: { type: 'string', description: 'Short headline (1 line).' },
            body: { type: 'string', description: 'Full content. For revisits, include both what to revisit and why we deferred.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Related file paths.' },
            branch: { type: 'string', description: 'Optional branch name this entry pertains to.' },
        },
        required: ['kind', 'title', 'body'],
    },
};

const RECALL_TOOL = {
    name: 'recall',
    description: [
        'Look up memory entries. With `query`, runs vector search and returns the top-k most semantically similar entries.',
        'WITHOUT `query`, runs in list mode (no embedding) sorted newest-first — use this to e.g. list all open revisits at session start:',
        '  recall({ kind: "revisit", status: "open" }).',
        'All filters (kind / tagsAny / status) compose with both modes.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Optional natural-language query. Omit for list mode (no embedding).' },
            k: { type: 'number', description: 'Max results (default 5 for search mode, 50 for list mode, hard cap 200).' },
            kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'REQUIRED. Which memory to query: "revisit" hits the parked-discussions table; any of note/bug-fix/gotcha/decision/investigation hits the findings table.' },
            tagsAny: { type: 'array', items: { type: 'string' }, description: 'Match if entry has any of these tags.' },
            status: { type: 'string', enum: [...MEMORY_STATUSES], description: 'Filter by status (typically "open" for revisit listings).' },
        },
        required: ['kind'],
    },
};

const UPDATE_MEMORY_TOOL = {
    name: 'update_memory',
    description: [
        'Mark a memory entry as resolved (acted on) or dismissed (no longer planning to do it).',
        'Primarily used to close out kind="revisit" entries returned by recall.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Memory entry id (returned by remember / recall).' },
            status: { type: 'string', enum: ['resolved', 'dismissed'], description: '"resolved" if we acted on it, "dismissed" if abandoned.' },
            resolution: { type: 'string', description: 'Optional notes on how it was resolved or why it was dismissed.' },
        },
        required: ['id', 'status'],
    },
};

const SEMANTIC_SEARCH_TOOL = {
    name: 'semantic_search',
    description: [
        'Conceptual vector search over the indexed codebase (and optionally memory entries).',
        'Use for "where does X happen" / "what handles Y" queries when you don\'t know the exact symbol.',
        'For known string/symbol lookups prefer the file-context `search` tool (ripgrep) — they are complementary.',
        'Returns code snippets ranked by semantic similarity; follow up with `read_lines` / `get_outline` for full context.',
        'When scope includes "memory", you MUST also pass `memoryKind` to choose which memory table to search (findings or revisits).',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you are looking for.' },
            k: { type: 'number', description: 'Max results (default 10, hard cap 100).' },
            scope: { type: 'string', enum: ['code', 'memory', 'both'], description: 'Where to search (default "code").' },
            pathGlob: { type: 'string', description: 'Optional glob to restrict code results by path (e.g. "src/AI/**").' },
            memoryKind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Required when scope is "memory" or "both". Picks which memory table (findings vs revisits) to search.' },
        },
        required: ['query'],
    },
};

const EDIT_MEMORY_TOOL = {
    name: 'edit_memory',
    description: [
        'Edit an existing memory entry in place: title, body, tags, paths, or branch.',
        'Re-embeds the vector when title or body change. Works for both findings and revisits.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Memory entry id (returned by remember / recall).' },
            title: { type: 'string', description: 'New short headline.' },
            body: { type: 'string', description: 'New full content.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Replacement paths list.' },
            branch: { type: 'string', description: 'Replacement branch (use empty string to clear).' },
        },
        required: ['id'],
    },
};
const TOOLS = [
    REMEMBER_TOOL,
    RECALL_TOOL,
    UPDATE_MEMORY_TOOL,
    EDIT_MEMORY_TOOL,
    SEMANTIC_SEARCH_TOOL,
];

type ToolName = (typeof TOOLS)[number]['name'];

async function dispatchTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case 'remember':
            return remember(args as unknown as Parameters<typeof remember>[0]);

        case 'recall':
            return recall(args as unknown as Parameters<typeof recall>[0]);

        case 'update_memory':
            return updateMemory(args as unknown as Parameters<typeof updateMemory>[0]);

        case 'edit_memory':
            return editMemory(args as unknown as Parameters<typeof editMemory>[0]);

        case 'semantic_search':
            return semanticSearch(args as unknown as Parameters<typeof semanticSearch>[0]);

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let pending = 0;
let inputClosed = false;

function maybeExit(): void {
    if (inputClosed && pending === 0) {
        process.exit(0);
    }
}

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

    pending++;
    void (async (): Promise<void> => {
        try {
            switch (request.method) {
                case 'initialize':
                    sendResult(id, {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'kra-memory', version: '1.0.0' },
                    });

                    return;

                case 'notifications/initialized':
                    return;

                case 'tools/list':
                    sendResult(id, { tools: TOOLS });

                    return;

                case 'tools/call': {
                    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
                    const toolName = params.name;

                    if (!toolName || !TOOLS.some((t) => t.name === toolName)) {
                        sendError(id, -32601, `Unknown tool: ${toolName ?? '(none)'}`);

                        return;
                    }

                    const result = await dispatchTool(toolName, params.arguments ?? {});

                    sendResult(id, {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        isError: false,
                    });

                    return;
                }

                default:
                    sendError(id, -32601, `Method not found: ${request.method}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendResult(id, {
                content: [{ type: 'text', text: `Error: ${message}` }],
                isError: true,
            });
        } finally {
            pending--;
            maybeExit();
        }
    })();
});

rl.on('close', () => {
    inputClosed = true;
    maybeExit();
});
