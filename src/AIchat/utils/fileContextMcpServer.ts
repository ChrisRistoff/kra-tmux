/**
 * Stdio MCP server exposing file-context tools for the agent:
 *
 *   get_outline(file_path)              — list functions/classes + line numbers
 *   read_lines(file_path, start, end)   — return a specific line range (1-indexed)
 *   read_function(file_path, name)      — return the body of a named symbol
 *   edit_lines(file_path, ...)          — replace a line range (or multiple ranges)
 *   create_file(file_path, content)     — create/overwrite a file
 *
 * The agent is directed to use these tools instead of the built-in str_replace_editor,
 * write_file, and read_file tools which are excluded from the session.
 *
 * Run directly: node dest/AIchat/utils/fileContextMcpServer.js
 */

import * as readline from 'readline';
import * as fs from 'fs/promises';
import path from 'path';
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

// Some agents occasionally JSON-encode array or number arguments as strings
// (e.g. `"[1, 5]"` or `"42"`). Coerce them back to structured values so we
// can validate uniformly regardless of how the model formatted them.
function coerceArray(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;

    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);

            return Array.isArray(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function coerceNumberArray(value: unknown): number[] | undefined {
    const arr = coerceArray(value);
    if (!arr) return undefined;

    const out: number[] = [];

    for (const v of arr) {
        if (typeof v === 'number' && Number.isFinite(v)) {
            out.push(v);
        } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
            out.push(Number(v));
        } else {
            return undefined;
        }
    }

    return out;
}

function coerceStringArray(value: unknown): string[] | undefined {
    const arr = coerceArray(value);
    if (!arr) return undefined;

    const out: string[] = [];

    for (const v of arr) {
        if (typeof v === 'string') {
            out.push(v);
        } else {
            return undefined;
        }
    }

    return out;
}

function coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }

    return undefined;
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
            'Supports multiple ranges in one call: pass startLines and endLines as parallel arrays (startLines[i] pairs with endLines[i]).',
            'Always prefer the array form over multiple separate calls.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to return (1-indexed). Single-range only.' },
                end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive). Single-range only.' },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Start lines for multiple ranges. Must be the same length as endLines.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'End lines for multiple ranges. Must be the same length as startLines.',
                },
            },
            required: ['file_path'],
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
            'Pass new_content as empty string to delete the lines without replacement.',
            'Returns the old replaced content so you can verify you edited the right section.',
            'Supports multiple edits in one call: pass startLines, endLines, and newContents as parallel arrays.',
            'Always prefer the array form over multiple separate calls.',
            'All line numbers must refer to the ORIGINAL file — the tool sorts ranges internally (largest first) so order does not matter.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to replace (1-indexed). Single-edit only.' },
                end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive). Single-edit only.' },
                new_content: {
                    type: 'string',
                    description: 'New content to insert in place of the replaced lines. Pass empty string to delete the lines. Single-edit only.',
                },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Start lines for multiple edits. Must be the same length as endLines and newContents.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'End lines for multiple edits. Must be the same length as startLines and newContents.',
                },
                newContents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Replacement content for each edit. Must be the same length as startLines and endLines.',
                },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'create_file',
        description: [
            'Creates a new file (or overwrites an existing one) with the given content.',
            'Parent directories are created automatically.',
            'Use this instead of str_replace_editor or write_file for all file creation.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file to create.' },
                content: { type: 'string', description: 'Full content to write to the file.' },
            },
            required: ['file_path', 'content'],
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
        const startLines = coerceNumberArray(args.startLines);
        const endLines = coerceNumberArray(args.endLines);

        if (startLines || endLines) {
            if (!startLines || !endLines || startLines.length !== endLines.length) {
                return errorContent('startLines and endLines must both be arrays of the same length.');
            }

            try {
                const content = await fs.readFile(filePath, 'utf8');
                const lines = content.split('\n');
                const sections: string[] = [];

                for (let i = 0; i < startLines.length; i++) {
                    const s = startLines[i];
                    const e = endLines[i];
                    const slice = lines.slice(s - 1, e);
                    const numbered = slice.map((l, j) => `${String(s + j).padStart(5)}: ${l}`);
                    sections.push(`Lines ${s}–${e}:\n${numbered.join('\n')}`);
                }

                return textContent(sections.join('\n\n'));
            } catch (err) {
                return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        const start = coerceNumber(args.start_line);
        const end = coerceNumber(args.end_line);

        if (!start || !end) {
            return errorContent('Provide start_line + end_line for a single range, or startLines + endLines arrays for multiple ranges.');
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
        const startLines = coerceNumberArray(args.startLines);
        const endLines = coerceNumberArray(args.endLines);
        const newContents = coerceStringArray(args.newContents);

        if (startLines || endLines || newContents) {
            if (!startLines || !endLines || !newContents ||
                startLines.length !== endLines.length || startLines.length !== newContents.length) {
                return errorContent('startLines, endLines, and newContents must all be arrays of the same length.');
            }

            // Validate no overlapping ranges before touching the file.
            for (let a = 0; a < startLines.length; a++) {
                for (let b = a + 1; b < startLines.length; b++) {
                    if (startLines[a] <= endLines[b] && startLines[b] <= endLines[a]) {
                        return errorContent(
                            `Ranges at index ${a} (${startLines[a]}–${endLines[a]}) and ${b} (${startLines[b]}–${endLines[b]}) overlap. ` +
                            'Make separate edit_lines calls for overlapping regions.'
                        );
                    }
                }
            }

            try {
                const raw = await fs.readFile(filePath, 'utf8');
                let lines = raw.split('\n');

                // sort edits bottom-to-top (by startLine desc) so earlier line numbers remain valid as we apply each edit.
                const indices = Array.from({ length: startLines.length }, (_, i) => i)
                    .sort((a, b) => startLines[b] - startLines[a]);

                const summaries: string[] = [];

                for (const i of indices) {
                    const start = startLines[i];
                    const end = endLines[i];
                    const newcContent = newContents[i];

                    if (start < 1 || end < start) {
                        return errorContent(`Invalid range at index ${i}: start_line (${start}) must be >= 1 and <= end_line (${end}).`);
                    }
                    if (start > lines.length) {
                        return errorContent(`start_line (${start}) at index ${i} is beyond the file length (${lines.length} lines).`);
                    }

                    const clampedEnd = Math.min(end, lines.length);
                    const insertLines = newcContent === '' ? [] : newcContent.split('\n');
                    lines = [...lines.slice(0, start - 1), ...insertLines, ...lines.slice(clampedEnd)];

                    const newEnd = start - 1 + insertLines.length;
                    summaries.push(
                        newcContent === ''
                            ? `Deleted lines ${start}–${clampedEnd}.`
                            : `Replaced lines ${start}–${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} (new lines ${start}–${newEnd}).`
                    );
                }

                await fs.writeFile(filePath, lines.join('\n'), 'utf8');

                return textContent(summaries.join('\n'));
            } catch (err) {
                return errorContent(`Could not edit file: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        const start = typeof args.start_line === 'number' ? args.start_line : undefined;
        const end = typeof args.end_line === 'number' ? args.end_line : undefined;
        const newContent = typeof args.new_content === 'string' ? args.new_content : undefined;

        if (!start || !end || !newContent) {
            return errorContent('Provide start_line + end_line + new_content for a single edit, or startLines + endLines + newContents arrays for multiple edits.');
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

    if (name === 'create_file') {
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (content === undefined) return errorContent('content argument is required.');

        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf8');
            const lineCount = content.split('\n').length;

            return textContent(`Created ${filePath} (${lineCount} line${lineCount === 1 ? '' : 's'}).`);
        } catch (err) {
            return errorContent(`Could not create file: ${err instanceof Error ? err.message : String(err)}`);
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
