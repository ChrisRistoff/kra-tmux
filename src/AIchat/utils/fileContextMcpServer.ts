/**
 * Stdio MCP server exposing file-context tools for the agent:
 *
 *   get_outline(file_path)              — list functions/classes + line numbers
 *   read_lines(file_path, start, end)   — return a specific line range (1-indexed)
 *   read_function(file_path, name)      — return the body of a named symbol
 *
 * The agent is directed to use these tools instead of reading large files in
 * full — the preToolUse hook intercepts large file reads and sends the outline
 * back as a denial reason, steering the model to these targeted alternatives.
 *
 * Run directly: node dest/AIchat/utils/fileContextMcpServer.js
 */

import * as readline from 'readline';
import * as fs from 'fs/promises';
import { getFileOutline, formatOutline, findFunctionRange } from './fileOutline';

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

function textContent(text: string): { content: { type: 'text'; text: string }[]; isError: boolean } {
    return { content: [{ type: 'text', text }], isError: false };
}

function errorContent(text: string): { content: { type: 'text'; text: string }[]; isError: boolean } {
    return { content: [{ type: 'text', text }], isError: true };
}

function getArgs(params: unknown): Record<string, unknown> {
    if (typeof params === 'object' && params !== null) {
        const p = params as Record<string, unknown>;
        if (typeof p.arguments === 'object' && p.arguments !== null) {
            return p.arguments as Record<string, unknown>;
        }
    }
    return {};
}

const TOOLS = [
    {
        name: 'get_outline',
        description: [
            'Returns a structured outline of a source file: function/class/method names and their line numbers.',
            'Use this before reading a large file to understand its structure, then use read_lines or read_function',
            'to fetch only the sections you need. Much cheaper than reading the whole file.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'read_lines',
        description: [
            'Returns specific lines from a file (1-indexed, inclusive).',
            'Use this to read only the section you need after checking the outline.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to return (1-indexed).' },
                end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive).' },
            },
            required: ['file_path', 'start_line', 'end_line'],
        },
    },
    {
        name: 'read_function',
        description: [
            'Returns the full body of a named function, class, or method from a file.',
            'More ergonomic than read_lines — just pass the symbol name and it finds the right line range for you.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                function_name: { type: 'string', description: 'Name of the function, class, or method to return.' },
            },
            required: ['file_path', 'function_name'],
        },
    },
    {
        name: 'edit_lines',
        description: [
            'Replaces a specific line range in a file with new content (1-indexed, inclusive).',
            'Use this for surgical edits to large files where reading/writing the whole file would waste context.',
            'Workflow: call get_outline to find line numbers, call read_lines to verify the current content,',
            'then call edit_lines to replace exactly those lines.',
            'Pass new_content as empty string to delete the lines without replacement.',
            'Returns the old replaced content so you can verify you edited the right section.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to replace (1-indexed).' },
                end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive).' },
                new_content: {
                    type: 'string',
                    description: 'New content to insert in place of the replaced lines. Pass empty string to delete the lines.',
                },
            },
            required: ['file_path', 'start_line', 'end_line', 'new_content'],
        },
    },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof textContent>> {
    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined;
    if (!filePath) return errorContent('file_path argument is required.');

    if (name === 'get_outline') {
        try {
            const outline = await getFileOutline(filePath);
            return textContent(formatOutline(filePath, outline));
        } catch (err) {
            return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'read_lines') {
        const start = typeof args.start_line === 'number' ? args.start_line : undefined;
        const end = typeof args.end_line === 'number' ? args.end_line : undefined;

        if (start === undefined || end === undefined) {
            return errorContent('start_line and end_line are required.');
        }

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const slice = lines.slice(start - 1, end);
            const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}: ${l}`);
            return textContent(numbered.join('\n'));
        } catch (err) {
            return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'read_function') {
        const fnName = typeof args.function_name === 'string' ? args.function_name : undefined;
        if (!fnName) return errorContent('function_name argument is required.');

        try {
            const outline = await getFileOutline(filePath);
            const range = findFunctionRange(outline, fnName);

            if (!range) {
                return errorContent(
                    `Symbol "${fnName}" not found in ${filePath}.\n\n${formatOutline(filePath, outline)}`
                );
            }

            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const slice = lines.slice(range.start - 1, range.end);
            const numbered = slice.map((l, i) => `${String(range.start + i).padStart(5)}: ${l}`);
            return textContent(`Lines ${range.start}–${range.end}:\n\n${numbered.join('\n')}`);
        } catch (err) {
            return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'edit_lines') {
        const start = typeof args.start_line === 'number' ? args.start_line : undefined;
        const end = typeof args.end_line === 'number' ? args.end_line : undefined;
        const newContent = typeof args.new_content === 'string' ? args.new_content : undefined;

        if (start === undefined || end === undefined || newContent === undefined) {
            return errorContent('start_line, end_line, and new_content are required.');
        }
        if (start < 1 || end < start) {
            return errorContent(`Invalid range: start_line (${start}) must be >= 1 and <= end_line (${end}).`);
        }

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const lines = raw.split('\n');

            if (start > lines.length) {
                return errorContent(`start_line (${start}) is beyond the file length (${lines.length} lines).`);
            }

            const clampedEnd = Math.min(end, lines.length);
            const oldLines = lines.slice(start - 1, clampedEnd);
            const oldNumbered = oldLines.map((l, i) => `${String(start + i).padStart(5)}: ${l}`).join('\n');

            const insertLines = newContent === '' ? [] : newContent.split('\n');
            const result = [...lines.slice(0, start - 1), ...insertLines, ...lines.slice(clampedEnd)];

            await fs.writeFile(filePath, result.join('\n'), 'utf8');

            const newEnd = start - 1 + insertLines.length;
            const summary = newContent === ''
                ? `Deleted lines ${start}–${clampedEnd} (${oldLines.length} line${oldLines.length === 1 ? '' : 's'}).`
                : `Replaced lines ${start}–${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} (new lines ${start}–${newEnd}).`;

            return textContent([
                summary,
                '',
                'Old content:',
                oldNumbered,
                ...(newContent !== '' ? ['', 'New content written successfully.'] : []),
            ].join('\n'));
        } catch (err) {
            return errorContent(`Could not edit file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return errorContent(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

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

            handleToolCall(toolName, toolArgs)
                .then((result) => sendResult(id, result))
                .catch((err) => sendResult(id, errorContent(String(err))));
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
