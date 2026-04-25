/**
 * Stdio MCP server exposing file-context tools for the agent:
 *
 *   get_outline(file_path)              — list functions/classes + line numbers
 *   read_lines(file_path, start, end)   — return a specific line range (1-indexed)
 *   read_function(file_path, name)      — return the body of a named symbol
 *   edit_lines(file_path, ...)          — replace a line range (or multiple ranges)
 *   create_file(file_path, content)     — create a NEW file (refuses if path exists)
 *
 * The agent is directed to use these tools instead of the built-in str_replace_editor,
 * write_file, and read_file tools which are excluded from the session.
 *
 * Run directly: node dest/src/AI/AIAgent/utils/fileContextMcpServer.js
 */
import 'module-alias/register';

import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { getFileOutline, formatOutline, findFunctionRange } from './fileOutline';
import { getDiagnosticsForFile } from './lspDiagnostics';
import {
    atomicWriteFile,
    isBinaryFile,
    MAX_LINES_PER_CALL,
} from './fileSafety';
import { TOOLS } from './fileContextMcpServerTools';
import { runLspQuery, LspOp, LspQueryArgs } from './lspQueryHandler';
import { getLspDiagnosticsForFile } from './lspDiagnosticsBridge';


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


// Hard cap on a single edit_lines range. There is intentionally NO override
// flag of any kind — neither agents nor MCP clients can bypass this. Larger
// changes must be split into multiple ranges (multi-edit array form counts
// each range separately).
const LARGE_RANGE_THRESHOLD = 100;

// ── Read-before-edit tracker ─────────────────────────────────────────────────
// Per-session memory of which (file, line) pairs the agent has actually
// inspected via read_lines / read_function / create_file. edit_lines refuses
// to touch lines that haven't been seen, forcing the agent to look before it
// rewrites. The cache is cleared for a file after any successful edit_lines
// or create_file, since line numbers shift and prior reads may no longer be
// accurate.
const seenLines = new Map<string, Set<number>>();

// ── Outline-before-read soft gate ────────────────────────────────────────────
// Files larger than OUTLINE_GATE_THRESHOLD lines that haven't been outlined yet
// in this session will have their outline returned instead of raw content when
// read_lines is called. This steers the AI toward targeted reads. Cleared
// (with seenLines) after each successful edit since line numbers shift.
const outlinedFiles = new Set<string>();
const OUTLINE_GATE_THRESHOLD = 150;

function canonicalPath(p: string): string {
    return path.resolve(p);
}

function markRead(filePath: string, start: number, end: number): void {
    const key = canonicalPath(filePath);
    let s = seenLines.get(key);
    if (!s) {
        s = new Set();
        seenLines.set(key, s);
    }
    for (let i = start; i <= end; i++) s.add(i);
}

function findUnreadGap(filePath: string, start: number, end: number): [number, number] | undefined {
    const s = seenLines.get(canonicalPath(filePath));
    if (!s) return [start, end];
    let gapStart: number | undefined;
    let gapEnd = start;
    for (let i = start; i <= end; i++) {
        if (!s.has(i)) {
            if (gapStart === undefined) gapStart = i;
            gapEnd = i;
        }
    }

    return gapStart !== undefined ? [gapStart, gapEnd] : undefined;
}

function clearReadCache(filePath: string): void {
    const key = canonicalPath(filePath);
    seenLines.delete(key);
    outlinedFiles.delete(key);
}

// Build a compact outline string for read_function not-found errors so we don't
// dump hundreds of entries back into the agent's context just to say "missing".
function formatOutlineForMiss(filePath: string, outline: Awaited<ReturnType<typeof getFileOutline>>, max = 40): string {
    if (outline.entries.length <= max) {
        return formatOutline(filePath, outline);
    }

    const truncated = { ...outline, entries: outline.entries.slice(0, max) };

    return `${formatOutline(filePath, truncated)}\n\n  ...and ${outline.entries.length - max} more (showing first ${max}). Use get_outline for the full list.`;
}
// Sum of (end - start + 1) across all requested ranges.
function totalRequestedLines(starts: number[], ends: number[]): number {
    let total = 0;
    for (let i = 0; i < starts.length; i++) total += Math.max(0, ends[i] - starts[i] + 1);

    return total;
}

// Append diagnostics (errors + warnings, single-file scope) to an edit
// summary so the agent sees them in the same turn it made the change.
//
// Source order:
//   1. If the file's extension has a configured LSP server in settings.toml,
//      ask that server (pull-mode `textDocument/diagnostic`, falling back to
//      cached push-mode `publishDiagnostics`). This is the same code path
//      used by editors like VS Code and Neovim.
//   2. Otherwise (or if the LSP path returned nothing usable), fall back to
//      the in-process TypeScript Compiler API check for .ts/.js files.
//
// Silent no-op when neither path produces diagnostics.
async function withDiagnostics(filePath: string, summary: string): Promise<string> {
    let diags: string | undefined;
    try {
        diags = await getLspDiagnosticsForFile(filePath);
    } catch {
        // ignore; try the in-process fallback
    }
    if (!diags) {
        try {
            diags = getDiagnosticsForFile(filePath);
        } catch {
            return summary;
        }
    }

    return diags ? `${summary}\n\n${diags}` : summary;
}

// Render a 1-indexed slice of `lines` with right-padded line numbers.
// Shared between read_lines (single + multi-range) and read_function so the
// numbering format stays in lock-step across tools.
function numberLines(lines: string[], start: number, end: number): string {
    return lines.slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}: ${l}`)
        .join('\n');
}

// ---------- search tool helpers ----------

const SEARCH_DEFAULT_MAX_RESULTS = 50;
const SEARCH_HARD_CAP_MAX_RESULTS = 200;
const SEARCH_LINE_TRUNCATE = 500;
const SEARCH_LINE_COUNT_CONCURRENCY = 16;

interface RgRunResult {
    stdout: string;
    stderr: string;
    code: number;
}

async function runRg(rgArgs: string[], cwd: string): Promise<RgRunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('rg', rgArgs, { cwd });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
}

// Returns the line count using the same `split('\n').length` semantics that
// read_lines uses internally, so a `read_lines 1-N` call lines up exactly.
// Returns 'binary' for files that fail the binary heuristic.
async function countFileLines(filePath: string): Promise<number | 'binary'> {
    try {
        if (await isBinaryFile(filePath)) return 'binary';

        const content = await fs.readFile(filePath, 'utf8');

        return content.split('\n').length;
    } catch {
        return 0;
    }
}

// Concurrency-capped Promise.all so a 50-file result set doesn't open 50 file
// handles at once.
async function countLinesForAll(filePaths: string[]): Promise<Map<string, number | 'binary'>> {
    const result = new Map<string, number | 'binary'>();
    let next = 0;

    async function worker(): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= filePaths.length) return;
            const fp = filePaths[i];
            result.set(fp, await countFileLines(fp));
        }
    }

    const workers = Array.from(
        { length: Math.min(SEARCH_LINE_COUNT_CONCURRENCY, filePaths.length) },
        async () => worker(),
    );
    await Promise.all(workers);

    return result;
}

function formatPathLine(filePath: string, count: number | 'binary'): string {
    if (count === 'binary') return `${filePath} (binary)`;

    return `${filePath} (${count} line${count === 1 ? '' : 's'})`;
}

function truncateMatchLine(line: string): string {
    if (line.length <= SEARCH_LINE_TRUNCATE) return line;

    return `${line.slice(0, SEARCH_LINE_TRUNCATE)}... [truncated]`;
}

interface RgMatchEntry {
    lineNumber: number;
    text: string;
    isMatch: boolean; // false for context lines
}

interface RgFileResult {
    path: string;
    entries: RgMatchEntry[]; // in encounter order
    matchCount: number;      // count of isMatch entries
}

interface RgEvent {
    type?: string;
    data?: unknown;
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'text' in value) {
        const t = (value as { text?: unknown }).text;

        return typeof t === 'string' ? t : undefined;
    }

    return undefined;
}

// Parse rg --json stream into per-file match groups, preserving order.
function parseRgJson(stdout: string): RgFileResult[] {
    const files: RgFileResult[] = [];
    let current: RgFileResult | undefined;

    for (const line of stdout.split('\n')) {
        if (!line) continue;

        let evt: RgEvent;
        try {
            evt = JSON.parse(line) as RgEvent;
        } catch {
            continue;
        }

        const data = evt.data as Record<string, unknown> | undefined;
        if (!data) continue;

        if (evt.type === 'begin') {
            const p = asString(data.path);
            if (p) {
                current = { path: p, entries: [], matchCount: 0 };
                files.push(current);
            }
            continue;
        }

        if ((evt.type === 'match' || evt.type === 'context') && current) {
            const lineNumber = typeof data.line_number === 'number' ? data.line_number : 0;
            const text = asString(data.lines) ?? '';

            // rg includes the trailing newline on each line; strip it so our
            // formatter doesn't introduce blank lines.
            const cleanText = text.endsWith('\n') ? text.slice(0, -1) : text;
            const isMatch = evt.type === 'match';

            current.entries.push({ lineNumber, text: cleanText, isMatch });
            if (isMatch) current.matchCount++;
            continue;
        }

        if (evt.type === 'end') {
            current = undefined;
        }
    }

    return files;
}

function renderRgFile(file: RgFileResult, lineCount: number | 'binary'): string {
    const header = formatPathLine(file.path, lineCount);
    const lines: string[] = [header];

    let prevLine = -2;
    for (const entry of file.entries) {
        if (prevLine !== -2 && entry.lineNumber > prevLine + 1) {
            lines.push('   --');
        }
        lines.push(`${String(entry.lineNumber).padStart(5)}: ${truncateMatchLine(entry.text)}`);
        prevLine = entry.lineNumber;
    }

    return lines.join('\n');
}

interface SearchOpts {
    namePattern: string | undefined;
    contentPattern: string | undefined;
    rootPath: string;
    type: string | undefined;
    caseInsensitive: boolean;
    context: number;
    multiline: boolean;
    maxResults: number;
}

async function searchNameOnly(opts: SearchOpts): Promise<string> {
    const args = ['--files', '--color', 'never'];
    if (opts.namePattern) {
        args.push('--glob', opts.namePattern);
    }
    if (opts.type) {
        args.push('--type', opts.type);
    }
    args.push('--', opts.rootPath);

    const { stdout, stderr, code } = await runRg(args, process.cwd());
    // rg returns 1 when no matches, 0 on matches; >1 is a real error.
    if (code > 1) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
    }

    const allPaths = stdout.split('\n').filter((p) => p.length > 0).sort();
    if (allPaths.length === 0) return 'No matching files.';

    const truncated = allPaths.length > opts.maxResults;
    const shown = truncated ? allPaths.slice(0, opts.maxResults) : allPaths;
    const counts = await countLinesForAll(shown);

    const lines = shown.map((p) => formatPathLine(p, counts.get(p) ?? 0));
    if (truncated) {
        lines.push(`... and ${allPaths.length - opts.maxResults} more results truncated. Narrow with name_pattern/path/type.`);
    }

    return lines.join('\n');
}

async function searchContent(opts: SearchOpts): Promise<string> {
    const args = ['--json', '--color', 'never'];
    if (opts.namePattern) {
        args.push('--glob', opts.namePattern);
    }
    if (opts.type) {
        args.push('--type', opts.type);
    }
    if (opts.caseInsensitive) {
        args.push('-i');
    }
    if (opts.context > 0) {
        args.push('-C', String(opts.context));
    }
    if (opts.multiline) {
        args.push('-U', '--multiline-dotall');
    }
    args.push('--', opts.contentPattern!, opts.rootPath);

    const { stdout, stderr, code } = await runRg(args, process.cwd());
    if (code > 1) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
    }

    const files = parseRgJson(stdout);
    if (files.length === 0) return 'No content matches.';

    files.sort((a, b) => a.path.localeCompare(b.path));

    // Cap by total match-line count (not context lines, not files).
    const cappedFiles: RgFileResult[] = [];
    let matchTotal = 0;
    let truncated = false;

    for (const file of files) {
        if (matchTotal >= opts.maxResults) {
            truncated = true;
            break;
        }

        const remaining = opts.maxResults - matchTotal;
        if (file.matchCount <= remaining) {
            cappedFiles.push(file);
            matchTotal += file.matchCount;
            continue;
        }

        // Trim entries: keep matches up to `remaining`, plus their adjacent context.
        const trimmedEntries: RgMatchEntry[] = [];
        let kept = 0;
        for (const entry of file.entries) {
            if (entry.isMatch) {
                if (kept >= remaining) break;
                kept++;
            }
            trimmedEntries.push(entry);
        }
        cappedFiles.push({ ...file, entries: trimmedEntries, matchCount: kept });
        matchTotal += kept;
        truncated = true;
        break;
    }

    const counts = await countLinesForAll(cappedFiles.map((f) => f.path));
    const sections = cappedFiles.map((f) => renderRgFile(f, counts.get(f.path) ?? 0));

    if (truncated) {
        const totalMatches = files.reduce((s, f) => s + f.matchCount, 0);
        sections.push(`... and ${totalMatches - matchTotal} more match line${totalMatches - matchTotal === 1 ? '' : 's'} truncated. Narrow with name_pattern/path/type.`);
    }

    return sections.join('\n\n');
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof textContent>> {
    if (name === 'lsp_query') {
        const filePath = typeof args.file_path === 'string' ? args.file_path : '';
        const op = args.op as LspOp;
        const queryArgs: LspQueryArgs = { file_path: filePath, op };
        if (typeof args.line === 'number') queryArgs.line = args.line;
        if (typeof args.col === 'number') queryArgs.col = args.col;
        if (typeof args.symbol === 'string') queryArgs.symbol = args.symbol;
        if (typeof args.occurrence === 'number') queryArgs.occurrence = args.occurrence;
        if (typeof args.include_declaration === 'boolean') queryArgs.include_declaration = args.include_declaration;
        try {
            const text = await runLspQuery(queryArgs);

            return textContent(text);
        } catch (err) {
            return errorContent(`lsp_query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'search') {
        const namePattern = typeof args.name_pattern === 'string' && args.name_pattern.length > 0
            ? args.name_pattern
            : undefined;
        const contentPattern = typeof args.content_pattern === 'string' && args.content_pattern.length > 0
            ? args.content_pattern
            : undefined;

        if (!namePattern && !contentPattern) {
            return errorContent('Provide name_pattern, content_pattern, or both. At least one is required.');
        }

        const rootPath = typeof args.path === 'string' && args.path.length > 0 ? args.path : process.cwd();
        const type = typeof args.type === 'string' && args.type.length > 0 ? args.type : undefined;
        const caseInsensitive = args.case_insensitive === true;
        const contextRaw = coerceNumber(args.context);
        const context = contextRaw && contextRaw > 0 ? Math.floor(contextRaw) : 0;
        const multiline = args.multiline === true;
        const maxRaw = coerceNumber(args.max_results);
        const maxResults = Math.min(
            SEARCH_HARD_CAP_MAX_RESULTS,
            maxRaw && maxRaw > 0 ? Math.floor(maxRaw) : SEARCH_DEFAULT_MAX_RESULTS,
        );

        const opts: SearchOpts = {
            namePattern,
            contentPattern,
            rootPath,
            type,
            caseInsensitive,
            context,
            multiline,
            maxResults,
        };

        try {
            const out = contentPattern
                ? await searchContent(opts)
                : await searchNameOnly(opts);

            return textContent(out);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('ENOENT')) {
                return errorContent('ripgrep (rg) not found on PATH. Install ripgrep to use the search tool.');
            }

            return errorContent(`search failed: ${msg}`);
        }
    }

    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined;
    if (!filePath) return errorContent('file_path argument is required.');


    if (name === 'get_outline') {
        try {
            const outline = await getFileOutline(filePath);

            outlinedFiles.add(canonicalPath(filePath));

            return textContent(formatOutline(filePath, outline));
        } catch (err) {
            return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'read_lines') {
        let startLines = coerceNumberArray(args.startLines);
        let endLines = coerceNumberArray(args.endLines);
        const isMulti = !!(startLines ?? endLines);

        if (isMulti) {
            if (!startLines || !endLines || startLines.length !== endLines.length) {
                return errorContent('startLines and endLines must both be arrays of the same length.');
            }
        } else {
            const start = coerceNumber(args.start_line);
            const end = coerceNumber(args.end_line);

            if (!start || !end) {
                return errorContent('Provide start_line + end_line for a single range, or startLines + endLines arrays for multiple ranges.');
            }

            startLines = [start];
            endLines = [end];
        }

        const totalLines = totalRequestedLines(startLines, endLines);
        if (totalLines > MAX_LINES_PER_CALL) {
            return errorContent(
                `Requested ${totalLines} lines across ${startLines.length} range${startLines.length === 1 ? '' : 's'}, exceeds the per-call cap of ${MAX_LINES_PER_CALL}. ` +
                'Split into multiple read_lines calls or narrow the ranges.'
            );
        }

        try {
            // Soft gate: if the file hasn't been outlined yet this session, return its
            // outline instead of raw content so the AI can make a targeted read.
            if (!outlinedFiles.has(canonicalPath(filePath))) {
                const outline = await getFileOutline(filePath);
                if (outline.lineCount > OUTLINE_GATE_THRESHOLD) {
                    outlinedFiles.add(canonicalPath(filePath));

                    return errorContent(
                        `File has ${outline.lineCount} lines — call \`get_outline\` first to identify the exact range you need, then retry read_lines with a targeted range.\n\n` +
                        formatOutline(filePath, outline)
                    );
                }
            }

            if (await isBinaryFile(filePath)) {
                return errorContent(`File appears to be binary: ${filePath}. Refusing to return its contents.`);
            }


            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const sections: string[] = [];

            for (let i = 0; i < startLines.length; i++) {
                const s = startLines[i];
                const e = endLines[i];
                const count = e - s + 1;
                const numbered = numberLines(lines, s, e);
                sections.push(`Lines ${s}\u2013${e} (${count} line${count === 1 ? '' : 's'}):\n${numbered}`);
            }

            for (let i = 0; i < startLines.length; i++) markRead(filePath, startLines[i], endLines[i]);

            return textContent(sections.join('\n\n'));
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
                    `Symbol "${fnName}" not found in ${filePath}.\n\n${formatOutlineForMiss(filePath, outline)}`
                );
            }

            const span = range.end - range.start + 1;
            if (span > MAX_LINES_PER_CALL) {
                return errorContent(
                    `Symbol "${fnName}" spans ${span} lines (${range.start}\u2013${range.end}), exceeds the per-call cap of ${MAX_LINES_PER_CALL}. ` +
                    'Use read_lines with a narrower range.'
                );
            }

            if (await isBinaryFile(filePath)) {
                return errorContent(`File appears to be binary: ${filePath}. Refusing to return its contents.`);
            }

            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const numbered = numberLines(lines, range.start, range.end);

            markRead(filePath, range.start, range.end);
            outlinedFiles.add(canonicalPath(filePath));

            return textContent(`Lines ${range.start}\u2013${range.end}:\n\n${numbered}`);
        } catch (err) {
            return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (name === 'edit_lines') {
        let startLines = coerceNumberArray(args.startLines);
        let endLines = coerceNumberArray(args.endLines);
        let newContents = coerceStringArray(args.newContents);
        const isMulti = !!(startLines ?? endLines ?? newContents);

        if (isMulti) {
            if (!startLines || !endLines || !newContents ||
                startLines.length !== endLines.length || startLines.length !== newContents.length) {
                return errorContent('startLines, endLines, and newContents must all be arrays of the same length.');
            }
        } else {
            const start = coerceNumber(args.start_line);
            const end = coerceNumber(args.end_line);
            const newContent = typeof args.new_content === 'string' ? args.new_content : undefined;

            if (!start || !end || newContent === undefined) {
                return errorContent('Provide start_line + end_line + new_content for a single edit, or startLines + endLines + newContents arrays for multiple edits.');
            }

            startLines = [start];
            endLines = [end];
            newContents = [newContent];
        }

        // O(n log n) overlap check, sort by start, scan adjacent pairs.
        // Loop body is a no-op for single-range edits, so this is safe to run unconditionally.
        const order = Array.from({ length: startLines.length }, (_, i) => i)
            .sort((a, b) => startLines[a] - startLines[b]);
        for (let i = 1; i < order.length; i++) {
            const prev = order[i - 1];
            const curr = order[i];
            if (endLines[prev] >= startLines[curr]) {
                return errorContent(
                    `Ranges at index ${prev} (${startLines[prev]}\u2013${endLines[prev]}) and ${curr} (${startLines[curr]}\u2013${endLines[curr]}) overlap. ` +
                    'Make separate edit_lines calls for overlapping regions.'
                );
            }
        }

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            let lines = raw.split('\n');

            // Validate range sizes against the ORIGINAL file before applying any edit.
            // Hard cap: no override of any kind. Larger changes must be split into
            // multiple ranges (multi-edit form counts each range separately).
            for (let i = 0; i < startLines.length; i++) {
                const start = startLines[i];
                const end = endLines[i];
                const where = isMulti ? ` at index ${i}` : '';

                if (start < 1 || end < start) {
                    return errorContent(`Invalid range${where}: start_line (${start}) must be >= 1 and <= end_line (${end}).`);
                }
                if (start > lines.length) {
                    return errorContent(`start_line (${start})${where} is beyond the file length (${lines.length} lines).`);
                }

                const clampedEnd = Math.min(end, lines.length);
                const span = clampedEnd - start + 1;
                if (span > LARGE_RANGE_THRESHOLD) {
                    return errorContent(
                        `Range${where} (${start}\u2013${end}) covers ${span} lines, exceeding the hard cap of ${LARGE_RANGE_THRESHOLD}. ` +
                        'Split the change into multiple smaller edit_lines calls (a multi-edit array call counts each range separately).'
                    );
                }

                const gap = findUnreadGap(filePath, start, clampedEnd);
                if (gap) {
                    return errorContent(
                        `Refusing to edit lines ${gap[0]}\u2013${gap[1]} of ${filePath}: those lines have not been read in this session. ` +
                        'Call read_lines or read_function on the target range first, then retry the edit. ' +
                        '(Read-tracking is reset for a file after each successful edit_lines/create_file.)'
                    );
                }
            }

            // Apply edits bottom-to-top (by startLine desc) so earlier line numbers remain valid as we apply each edit.
            const indices = Array.from({ length: startLines.length }, (_, i) => i)
                .sort((a, b) => startLines[b] - startLines[a]);

            const summaries: string[] = [];

            for (const i of indices) {
                const start = startLines[i];
                const end = endLines[i];
                const newContent = newContents[i];
                const clampedEnd = Math.min(end, lines.length);
                const insertLines = newContent === '' ? [] : newContent.split('\n');
                lines = [...lines.slice(0, start - 1), ...insertLines, ...lines.slice(clampedEnd)];

                const newEnd = start - 1 + insertLines.length;
                summaries.push(
                    newContent === ''
                        ? `Deleted lines ${start}\u2013${clampedEnd}.`
                        : `Replaced lines ${start}\u2013${clampedEnd} with ${insertLines.length} line${insertLines.length === 1 ? '' : 's'} (new lines ${start}\u2013${newEnd}).`
                );
            }

            await atomicWriteFile(filePath, lines.join('\n'));
            clearReadCache(filePath);

            return textContent(await withDiagnostics(filePath, summaries.join('\n')));
        } catch (err) {
            return errorContent(`Could not edit file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }


    if (name === 'create_file') {
        const content = typeof args.content === 'string' ? args.content : undefined;
        if (content === undefined) return errorContent('content argument is required.');

        // create_file is for NEW files only. Modifications to existing files must
        // go through edit_lines (multi-range form for changes spanning multiple
        // regions). This prevents bypassing the edit_lines cap by overwriting.
        let exists = false;
        try { await fs.access(filePath); exists = true; } catch { /* does not exist */ }
        if (exists) {
            return errorContent(
                `Refusing to create_file: ${filePath} already exists. Use edit_lines to modify existing files ` +
                '(use the multi-range form \u2014 startLines/endLines/newContents arrays \u2014 for changes spanning multiple regions).'
            );
        }

        try {
            await atomicWriteFile(filePath, content);

            const lineCount = content.split('\n').length;

            clearReadCache(filePath);
            markRead(filePath, 1, lineCount);

            return textContent(await withDiagnostics(filePath, `Created ${filePath} (${lineCount} line${lineCount === 1 ? '' : 's'}).`));
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
