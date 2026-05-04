#!/usr/bin/env node
/**
 * Stdio MCP server exposing file-context tools for the agent:
 *
 *   lsp_query(file_path, op, ...)        — LSP-backed hover / definition / etc.
 *   search(name_pattern?, content_pattern?, ...) — ripgrep wrapper
 *   get_outline(file_path)               — list functions/classes + line numbers
 *   read_lines(file_path, start, end)    — return a specific line range (1-indexed)
 *   read_function(file_path, name)       — return the body of a named symbol
 *   edit(file_path, edits[])             — anchor-based edit (replace/insert/delete)
 *   create_file(file_path, content)      — create a NEW file (refuses if exists)
 *
 * The agent is directed to use these tools instead of the built-in
 * str_replace_editor, write_file, and read_file tools (which are excluded
 * from the session).
 *
 * Run directly:
 *   node dest/src/AI/AIAgent/shared/utils/fileContextMcpServer.js
 *
 * Implementation note: this file is intentionally a thin JSON-RPC adapter.
 * All tool logic lives in `../fileContext/` so each handler can be tested
 * (and edited) in isolation. Mirrors the layout of `memoryMcpServer.ts` +
 * `shared/memory/`.
 */
import 'module-alias/register';

import { runStdioMcpServer } from '../../mcp/stdioServer';
import { dispatchFileContextTool } from '../fileContext/dispatch';
import { TOOLS } from '../fileContext/tools';
import { errorContent, getArgs } from '../fileContext';

// Belt-and-suspenders: never let an unhandled error from a spawned LSP child
// (or any other async chain) tear down the MCP server. Without these, a single
// unhandled rejection or uncaught exception kills the stdio server with no
// chance for the parent CLI to reconnect, leaving the agent without file tools.
process.on('uncaughtException', (err) => {
    process.stderr.write(`[mcp] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[mcp] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

runStdioMcpServer({
    serverName: 'kra-file-context',
    tools: TOOLS,
    allowPing: true,
    respondParseError: false,
    handleToolCall: async ({ toolName, params }) => {
        const toolArgs = getArgs(params);

        try {
            return await dispatchFileContextTool(toolName, toolArgs);
        } catch (err) {
            return errorContent(String(err));
        }
    },
    onInternalError: (error) => ({
        kind: 'result',
        result: errorContent(String(error)),
    }),
});
