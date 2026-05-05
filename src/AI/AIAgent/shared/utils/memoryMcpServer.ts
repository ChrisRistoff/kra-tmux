#!/usr/bin/env node
/**
 * kra-memory MCP server — exposes the Phase 1 memory tools to agents.
 *
 * Mirrors the JSON-RPC stdio pattern used by `bashMcpServer.ts` and
 * `webMcpServer.ts`. All operations resolve `<repo>` from
 * `process.env.WORKING_DIR` (set by the spawning provider) so memory is
 * scoped per agent workspace.
 */

import { runStdioMcpServer } from '../../mcp/stdioServer';
import 'module-alias/register';
import { editMemory, recall, remember, updateMemory } from '../memory/notes';
import { semanticSearch } from '../memory/search';
import { docsSearch } from '../docs/search';
import { MEMORY_KINDS, MEMORY_LOOKUP_KINDS, MEMORY_STATUSES } from '../memory/types';
import { loadSettings } from '@/utils/common';
import type { DocsSource } from '@/types/settingsTypes';

const REMEMBER_TOOL = {
    name: 'remember',
    description: 'Persist a long-term note about this repo (bug-fix, gotcha, decision, investigation, note) or PARK an idea via kind="revisit" (stays open until update_memory). Body must contain enough detail for a future session to act without re-investigating.',
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
    description: 'Look up memory entries. With `query`: vector search (top-k). Without `query`: list mode (newest-first). `kind` is required (`findings`, `revisit`, or a specific finding kind). For conceptual discovery across memories prefer `semantic_search({ scope: "memory"|"both", memoryKind: "findings" })`. Filters (tagsAny/status) compose with both modes.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Optional natural-language query. Omit for list mode (no embedding).' },
            k: { type: 'number', description: 'Max results (default 5 for search mode, 50 for list mode, hard cap 200).' },
            kind: { type: 'string', enum: [...MEMORY_LOOKUP_KINDS], description: 'REQUIRED. `findings` queries the findings table, `revisit` queries parked discussions, and specific finding kinds narrow the findings table.' },
            selectedIds: { type: 'array', items: { type: 'string' }, description: 'Optional pre-approved memory ids to limit the result set.' },
            tagsAny: { type: 'array', items: { type: 'string' }, description: 'Match if entry has any of these tags.' },
            status: { type: 'string', enum: [...MEMORY_STATUSES], description: 'Filter by status (typically "open" for revisit listings).' },
        },
        required: ['kind'],
    },
};

const UPDATE_MEMORY_TOOL = {
    name: 'update_memory',
    description: 'Mark a memory entry as resolved (acted on) or dismissed. Primarily used to close out kind="revisit" entries.',
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
        'Conceptual vector search over the indexed codebase (and optionally memory). Preferred first-step discovery when you do NOT already know the exact symbol/file/path/string.',
        'For new non-trivial tasks, start with `scope: "both", memoryKind: "findings"`. For known literals, prefer the file-context `search` or `lsp_query`.',
        'Returns ONE entry per matched file (deduped) with parallel `startLines`/`endLines` of merged matched ranges, plus an `outline` annotated with a `matched` flag. No source code returned — follow up with `read_lines` (you can pass startLines/endLines straight through) or `read_function`.',
        'When scope includes "memory", set `memoryKind` (`findings`, `revisit`, or a specific finding kind).',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you are looking for.' },
            k: { type: 'number', description: 'Max results (default 10, hard cap 100).' },
            scope: { type: 'string', enum: ['code', 'memory', 'both'], description: 'Where to search (default "code").' },
            pathGlob: { type: 'string', description: 'Optional glob to restrict code results by path (e.g. "src/AI/**").' },
            memoryKind: { type: 'string', enum: [...MEMORY_LOOKUP_KINDS], description: 'Required when scope is "memory" or "both". Use `findings` for long-term memories, `revisit` for parked discussions, or a specific finding kind to narrow the findings table.' },
            selectedIds: { type: 'array', items: { type: 'string' }, description: 'Optional pre-approved memory ids to limit returned memory hits.' },
        },
        required: ['query'],
    },
};

const EDIT_MEMORY_TOOL = {
    name: 'edit_memory',
    description: 'Edit an existing memory entry in place (title/body/tags/paths/branch). Re-embeds the vector when title or body changes. Works for findings and revisits.',
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

const DOCS_SEARCH_TOOL_BASE = {
    name: 'docs_search',
    description: [
        'PREFERRED first-step lookup for questions about external libraries/SDKs/services whose docs are listed below. Vector search over the local indexed docs corpus (no network).',
        'Returns one entry per matched page (deduped by URL) with best-scoring sections inlined as markdown \u2014 read directly, no follow-up fetch needed. Use `sourceAlias` to scope to a single source.',
        'Try this BEFORE `web_search`/`web_fetch` when the topic matches a listed source (faster, offline, version-pinned). Use `semantic_search` for questions about THIS repo\u2019s own code.',
    ].join(' '),
};

export function buildDocsSearchTool(sources: DocsSource[]) {
    const aliasLines = sources
        .map((s) => {
            const blurb = s.description?.trim() || s.url;

            return `  - ${s.alias} \u2014 ${blurb}`;
        })
        .join('\n');
    const aliases = sources.map((s) => s.alias);

    const description = [
        DOCS_SEARCH_TOOL_BASE.description,
        '',
        'Available sources (configured for this repo \u2014 only these aliases are valid for `sourceAlias`):',
        aliasLines,
    ].join('\n');

    return {
        name: DOCS_SEARCH_TOOL_BASE.name,
        description,
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language description of what you are looking for.' },
                k: { type: 'number', description: 'Max pages returned (default 8, hard cap 50).' },
                sourceAlias: {
                    type: 'string',
                    enum: aliases,
                    description: 'Optional alias filter. Must be one of the configured aliases listed in this tool\u2019s description.',
                },
            },
            required: ['query'],
        },
    };
}
export async function buildToolList(): Promise<Array<{ name: string }>> {
    const tools: Array<{ name: string }> = [
        REMEMBER_TOOL,
        RECALL_TOOL,
        UPDATE_MEMORY_TOOL,
        EDIT_MEMORY_TOOL,
        SEMANTIC_SEARCH_TOOL,
    ];

    try {
        const settings = await loadSettings();
        const docsCfg = settings.ai?.docs;
        const sources = docsCfg?.enabled ? (docsCfg.sources ?? []) : [];
        if (sources.length > 0) {
            tools.push(buildDocsSearchTool(sources));
        }
    } catch {
    }

    return tools;
}

type ToolName = 'remember' | 'recall' | 'update_memory' | 'edit_memory' | 'semantic_search' | 'docs_search';

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

        case 'docs_search':
            return docsSearch(args as unknown as Parameters<typeof docsSearch>[0]);

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

async function startServer(): Promise<void> {
    const TOOLS = await buildToolList();

    runStdioMcpServer({
        serverName: 'kra-memory',
        tools: TOOLS,
        handleToolCall: async ({ toolName, params }) => {
            const callParams = (params ?? {}) as { arguments?: unknown };
            const rawArgs = callParams.arguments;
            const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
            const result = await dispatchTool(toolName as ToolName, args);

            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: false,
            };
        },
        onInternalError: (error) => {
            const message = error instanceof Error ? error.message : String(error);

            return {
                kind: 'result',
                result: {
                    content: [{ type: 'text', text: `Error: ${message}` }],
                    isError: true,
                },
            };
        },
    });
}

if (require.main === module) {
    startServer().catch((err) => {
        console.error('memoryMcpServer failed to start:', err);
        process.exit(1);
    });
}