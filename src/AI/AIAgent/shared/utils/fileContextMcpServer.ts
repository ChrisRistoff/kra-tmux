#!/usr/bin/env node
/**
 * Stdio MCP server exposing file-context tools for the agent:
 *
 *   lsp_query(file_path, op, ...)        \u2014 LSP-backed hover / definition / etc.
 *   search(name_pattern?, content_pattern?, ...) \u2014 ripgrep wrapper
 *   get_outline(file_path)               \u2014 list functions/classes + line numbers
 *   read_lines(file_path, start, end)    \u2014 return a specific line range (1-indexed)
 *   read_function(file_path, name)       \u2014 return the body of a named symbol
 *   edit_lines(file_path, ...)           \u2014 replace one or more line ranges
 *   create_file(file_path, content)      \u2014 create a NEW file (refuses if exists)
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

import * as readline from 'readline';
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

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let pending = 0;
let inputClosed = false;

function maybeExit(): void {
    if (inputClosed && pending === 0) process.exit(0);
}

rl.on('line', (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) return;

    let request: JsonRpcRequest;

    try {
        request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
        return;
    }

    const id = request.id ?? null;

    switch (request.method) {
        case 'initialize':
            sendResult(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'kra-file-context', version: '1.0.0' },
            });
            break;

        case 'notifications/initialized':
            break;

        case 'tools/list':
            sendResult(id, { tools: TOOLS });
            break;

        case 'tools/call': {
            const params = request.params as Record<string, unknown> | undefined;
            const toolName = typeof params?.name === 'string' ? params.name : '';
            const toolArgs = getArgs(params);

            pending++;
            dispatchFileContextTool(toolName, toolArgs)
                .then((result) => sendResult(id, result))
                .catch((err) => sendResult(id, errorContent(String(err))))
                .finally(() => {
                    pending--;
                    maybeExit();
                });
            break;
        }

        case 'ping':
            sendResult(id, {});
            break;

        default:
            sendError(id, -32601, `Method not found: ${request.method}`);
            break;
    }
});

rl.on('close', () => {
    inputClosed = true;
    maybeExit();
});
