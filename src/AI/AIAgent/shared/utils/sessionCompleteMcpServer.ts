/**
 * Minimal stdio MCP server that exposes a single tool: confirm_task_complete.
 *
 * The AI is instructed to call this tool whenever it believes the task is
 * done OR whenever it needs to ask the user anything (clarifications,
 * decisions, next steps). The real handling happens in onPreToolUse in
 * agentConversation.ts — this server just needs to satisfy the MCP
 * protocol so the SDK can discover and call the tool.
 *
 * Run directly: node dest/AI/AIAgent/utils/sessionCompleteMcpServer.js
 */

import * as readline from 'readline';

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
    name: 'confirm_task_complete',
    description: [
        'You MUST call this tool in two situations:',
        '1. When you believe all assigned tasks are complete and you want to end your turn.',
        '2. When you need to ask the user anything — clarifications, decisions, follow-up questions, or next steps.',
        'Do NOT end your turn with plain text. Always call this tool instead.',
        'Pass a concise summary of what was done (or what you need to ask) in the "summary" argument,',
        'and a list of 2–4 concrete choices for the user in the "choices" argument.',
        'The user will pick a choice or type a custom reply; their answer will be returned to you so you can continue.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A concise summary of what was accomplished, or what question you are asking the user.',
            },
            choices: {
                type: 'array',
                items: { type: 'string' },
                description: 'Two to four concrete choices to present to the user (e.g. ["Continue with X", "Try Y instead", "We are done"]).',
            },
        },
        required: ['summary', 'choices'],
    },
};

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
        // Malformed — ignore
        return;
    }

    const id = request.id ?? null;

    switch (request.method) {
        case 'initialize':
            sendResult(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'kra-session-complete', version: '1.0.0' },
            });
            break;

        case 'notifications/initialized':
            // No response for notifications
            break;

        case 'tools/list':
            sendResult(id, { tools: [TOOL_DEFINITION] });
            break;

        case 'tools/call': {
            // The real work happens in onPreToolUse. This just needs to
            // return a valid result so the SDK doesn't error out in case
            // onPreToolUse allows the call through.
            sendResult(id, {
                content: [{ type: 'text', text: 'User has been prompted. Continue based on their reply.' }],
                isError: false,
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
    process.exit(0);
});
