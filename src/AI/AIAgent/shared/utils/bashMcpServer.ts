#!/usr/bin/env node
/**
 * kra-bash MCP server — exposes a single `bash` tool to BYOK agents.
 *
 * Mirrors the JSON-RPC stdio pattern used by sessionCompleteMcpServer.ts so we
 * have no extra runtime dependency. Commands run in `process.env.WORKING_DIR`
 * (set by the spawning provider) so the agent stays inside its proposal
 * workspace.
 */

import { exec } from 'child_process';
import readline from 'readline';

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

const TOOL_DEFINITION = {
    name: 'bash',
    description: [
        'Execute a shell command and return its combined stdout/stderr.',
        'Runs in the agent working directory with a 120s default timeout and 10MB output cap.',
        'Output longer than ~8000 chars is truncated to first 2000 + last 6000 chars (middle elided).',
        'Use this for builds, tests, linting, file inspection, git, etc.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to execute (interpreted by /bin/sh -c).',
            },
            timeoutMs: {
                type: 'number',
                description: 'Optional timeout override in milliseconds. Defaults to 120000.',
            },
        },
        required: ['command'],
    },
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const HEAD_KEEP = 2_000;
const TAIL_KEEP = 6_000;

function truncateMiddle(text: string): string {
    if (text.length <= HEAD_KEEP + TAIL_KEEP) {
        return text;
    }

    const droppedChars = text.length - HEAD_KEEP - TAIL_KEEP;
    const head = text.slice(0, HEAD_KEEP);
    const tail = text.slice(text.length - TAIL_KEEP);

    return `${head}\n\n... [truncated ${droppedChars} chars from middle] ...\n\n${tail}`;
}

interface BashArgs {
    command: string;
    timeoutMs?: number;
}

async function runBash(args: BashArgs): Promise<{ output: string; isError: boolean }> {
    const cwd = process.env['WORKING_DIR'] ?? process.cwd();
    const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
        exec(
            args.command,
            { cwd, timeout, maxBuffer: MAX_BUFFER, shell: '/bin/sh' },
            (error, stdout, stderr) => {
                const output = [
                    stdout ? `stdout:\n${truncateMiddle(stdout)}` : '',
                    stderr ? `stderr:\n${truncateMiddle(stderr)}` : '',
                    error ? `exit: ${error.code ?? 'error'} — ${error.message}` : '',
                ]
                    .filter(Boolean)
                    .join('\n\n') || '(no output)';

                resolve({ output, isError: Boolean(error) });
            }
        );
    });
}

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
                        serverInfo: { name: 'kra-bash', version: '1.0.0' },
                    });

                    return;

                case 'notifications/initialized':
                    return;

                case 'tools/list':
                    sendResult(id, { tools: [TOOL_DEFINITION] });

                    return;

                case 'tools/call': {
                    const params = (request.params ?? {}) as { name?: string; arguments?: BashArgs };

                    if (params.name !== 'bash') {
                        sendError(id, -32601, `Unknown tool: ${params.name ?? '(none)'}`);

                        return;
                    }

                    const args = params.arguments;

                    if (!args || typeof args.command !== 'string') {
                        sendError(id, -32602, 'Missing required argument: command');

                        return;
                    }

                    const { output, isError } = await runBash(args);

                    sendResult(id, {
                        content: [{ type: 'text', text: output }],
                        isError,
                    });

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
