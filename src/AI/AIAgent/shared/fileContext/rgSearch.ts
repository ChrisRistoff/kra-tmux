import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { isBinaryFile } from '../utils/fileSafety';

export const SEARCH_DEFAULT_MAX_RESULTS = 50;
export const SEARCH_HARD_CAP_MAX_RESULTS = 200;

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
        for (;;) {
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
    isMatch: boolean;
}

interface RgFileResult {
    path: string;
    entries: RgMatchEntry[];
    matchCount: number;
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

export interface SearchOpts {
    namePattern: string | undefined;
    contentPattern: string | undefined;
    rootPath: string;
    type: string | undefined;
    caseInsensitive: boolean;
    context: number;
    multiline: boolean;
    maxResults: number;
}

export async function searchNameOnly(opts: SearchOpts): Promise<string> {
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

export async function searchContent(opts: SearchOpts): Promise<string> {
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

    args.push('--', opts.contentPattern ?? '', opts.rootPath);

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
