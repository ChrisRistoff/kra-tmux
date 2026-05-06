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
import * as path from 'path';
import * as fs from 'fs';
import { JsonRpcToolError, runStdioMcpServer } from '../../mcp/stdioServer';

interface SelectedRepo { alias: string; root: string }

function getSelectedRepos(): SelectedRepo[] {
    const raw = process.env['KRA_SELECTED_REPO_ROOTS'];
    if (!raw) return [];
    const out: SelectedRepo[] = [];
    for (const line of raw.split('\n')) {
        const [alias, root] = line.split('\t');
        if (alias && root) out.push({ alias, root });
    }

    return out;
}

/**
 * Resolve and validate a caller-supplied `cwd` for the bash tool.
 * Accepts either an absolute path or a repo alias from `KRA_SELECTED_REPO_ROOTS`.
 * The resolved path must equal-to or live under one of the selected repo roots
 * (or under WORKING_DIR if no repo set was advertised) — this prevents the
 * agent from escaping the proposal workspace via `cwd` traversal.
 */
function resolveBashCwd(requested: string | undefined): { cwd: string; err?: string } {
    const fallback = process.env['WORKING_DIR'] ?? process.cwd();
    if (!requested) {
        return { cwd: fallback };
    }

    const repos = getSelectedRepos();

    const aliasMatch = repos.find((r) => r.alias === requested);
    if (aliasMatch) {
        return { cwd: aliasMatch.root };
    }

    if (!path.isAbsolute(requested)) {
        return {
            cwd: fallback,
            err: `cwd must be an absolute path or one of the selected repo aliases (${repos.map((r) => r.alias).join(', ') || '<none>'}). Got: ${requested}`,
        };
    }

    const resolved = path.resolve(requested);
    let stat;
    try { stat = fs.statSync(resolved); } catch {
        return { cwd: fallback, err: `cwd does not exist: ${resolved}` };
    }
    if (!stat.isDirectory()) {
        return { cwd: fallback, err: `cwd is not a directory: ${resolved}` };
    }

    if (repos.length > 0) {
        const allowedRoots = repos.map((r) => path.resolve(r.root));
        const isUnderAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
        if (!isUnderAllowed) {
            return {
                cwd: fallback,
                err: `cwd must live under one of the selected repos: ${allowedRoots.join(', ')}. Got: ${resolved}`,
            };
        }
    }

    return { cwd: resolved };
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
            cwd: {
                type: 'string',
                description: 'Optional working directory. Either an absolute path under one of the selected repos, or a repo alias (e.g. "my-other-repo"). Defaults to the primary repo. Use this to run commands inside a non-primary repo in a multi-repo workspace.',
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
    cwd?: string;
}

async function runBash(args: BashArgs): Promise<{ output: string; isError: boolean }> {
    const { cwd, err: cwdErr } = resolveBashCwd(args.cwd);
    if (cwdErr) {
        return { output: `cwd error: ${cwdErr}`, isError: true };
    }
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
            ...(typeof args.cwd === 'string' && args.cwd.length > 0 ? { cwd: args.cwd } : {}),
        });

        return {
            content: [{ type: 'text', text: output }],
            isError,
        };
    },
});