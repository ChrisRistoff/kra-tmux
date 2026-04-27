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
import { JsonRpcToolError, runStdioMcpServer } from '../../mcp/stdioServer';

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

runStdioMcpServer({
    serverName: 'kra-bash',
    tools: [TOOL_DEFINITION],
    handleToolCall: async ({ params }) => {
        const rawArgs = (params as { arguments?: unknown }).arguments;
        const args = (rawArgs ?? {}) as Partial<BashArgs>;

        if (typeof args.command !== 'string') {
            throw new JsonRpcToolError(-32602, 'Missing required argument: command');
        }

        const { output, isError } = await runBash({
            command: args.command,
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        });

        return {
            content: [{ type: 'text', text: output }],
            isError,
        };
    },
});