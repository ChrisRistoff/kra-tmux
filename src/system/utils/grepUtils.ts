import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { escTag, sanitizeForBlessed } from '@/UI/dashboard';
import { execCommand } from '@/utils/bashHelper';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SearchMode = 'files' | 'dirs' | 'content';

export interface GrepResult {
    displayPath: string;   // path shown in the list (relative)
    absPath: string;       // absolute path for actions
    type: 'file' | 'dir';
    matchCount: number;    // 0 for name-search, N for content hits
    matches: string[];     // matching lines (content mode); loaded lazily
    selected: boolean;     // batch-delete marker
}

export const RESULT_LIMIT_NAME = 5000;
export const RESULT_LIMIT_CONTENT = 5000;
export const PREVIEW_MATCH_LIMIT = 200;
export const PREVIEW_MAX_LINES = 8000;

export interface ContentPreview {
    content: string;
    firstMatchLine: number;
    totalLines: number;
    matchCount: number;
}

export interface StreamSearchHandle {
    cancel: () => void;
    done: Promise<void>;
}

// ─── Streaming runner ─────────────────────────────────────────────────────────

interface StreamOptions {
    cmd: string;
    args: string[];
    cwd: string;
    maxLines: number;
    onLines: (batch: string[]) => void;
}

function streamLines({ cmd, args, cwd, maxLines, onLines }: StreamOptions): StreamSearchHandle {
    let child: ReturnType<typeof spawn> | null = null;
    try {
        // stdio: ignore stdin so rg doesn't wait on stdin when no path arg is
        // given (no-TTY default). pipe stdout/stderr.
        child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
        return { cancel: () => { /* noop */ }, done: Promise.resolve() };
    }

    let buffer = '';
    let count = 0;
    let done = false;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((r) => { resolveDone = r; });

    const finish = (): void => {
        if (done) return;
        done = true;
        if (buffer && count < maxLines) {
            onLines([buffer]);
            buffer = '';
        }
        resolveDone();
    };

    const cancel = (): void => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        finish();
    };

    if (!child.stdout) {
        finish();

        return { cancel, done: donePromise };
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        if (done) return;
        buffer += chunk;
        const batch: string[] = [];
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line) {
                batch.push(line);
                count++;
                if (count >= maxLines) {
                    if (batch.length > 0) onLines(batch);
                    cancel();

                    return;
                }
            }
            idx = buffer.indexOf('\n');
        }
        if (batch.length > 0) onLines(batch);
    });
    child.stdout.on('error', () => { /* swallow SIGPIPE */ });
    child.stderr?.on('data', () => { /* swallow */ });
    child.on('error', () => finish());
    child.on('close', () => finish());

    return { cancel, done: donePromise };
}

// ─── Search helpers ───────────────────────────────────────────────────────────

function lineToNameResult(line: string, cwd: string, type: 'file' | 'dir'): GrepResult {
    const rel = line.startsWith('./') ? line : `./${line}`;

    return {
        displayPath: rel,
        absPath: path.resolve(cwd, line),
        type,
        matchCount: 0,
        matches: [],
        selected: false,
    };
}

export function searchByNameStream(
    query: string,
    type: 'f' | 'd',
    cwd: string,
    onResults: (batch: GrepResult[]) => void,
): StreamSearchHandle {
    const trimmed = query.trim();
    if (!trimmed) return { cancel: () => { /* noop */ }, done: Promise.resolve() };

    const glob = `*${trimmed}*`;
    const resultType: 'file' | 'dir' = type === 'f' ? 'file' : 'dir';
    const opts = type === 'f'
        ? { cmd: 'rg', args: ['--files', '--iglob', glob, '--color=never'] }
        : {
            cmd: 'find',
            args: [
                '.', '-type', 'd',
                '-not', '-path', '*/node_modules/*',
                '-not', '-path', '*/.git/*',
                '-iname', glob,
            ],
        };

    return streamLines({
        ...opts,
        cwd,
        maxLines: RESULT_LIMIT_NAME,
        onLines: (batch) => {
            onResults(batch.map((p) => lineToNameResult(p, cwd, resultType)));
        },
    });
}

// Back-compat helper used by tests; collects the stream into a single array.
export async function searchByName(
    query: string,
    type: 'f' | 'd',
    cwd: string,
): Promise<GrepResult[]> {
    const out: GrepResult[] = [];
    const handle = searchByNameStream(query, type, cwd, (batch) => { out.push(...batch); });
    await handle.done;

    return out;
}

export function searchContentStream(
    query: string,
    cwd: string,
    onResults: (batch: GrepResult[]) => void,
): StreamSearchHandle {
    if (!query.trim()) return { cancel: () => { /* noop */ }, done: Promise.resolve() };

    // -l (files-with-matches) lets rg early-exit per file as soon as it finds
    // the first hit. Much faster than -c (which has to count every match).
    // Match count is loaded lazily per file when the user selects it.
    return streamLines({
        cmd: 'rg',
        // -F = fixed-strings (literal). Without this, queries like
        // "import { foo } from '@/x';" are parsed as regex and either
        // match nothing (unbalanced `{`) or backtrack pathologically.
        // This is what telescope/fzf-lua use for `grep_string`.
        // Trailing '.' is the search path. Without it, rg with no TTY waits on
        // stdin (this is the bug that made content search hang forever).
        args: ['-l', '-F', '--color=never', '--no-messages', '--', query, '.'],
        cwd,
        maxLines: RESULT_LIMIT_CONTENT,
        onLines: (batch) => {
            onResults(batch.map((filePath) => {
                const rel = filePath.startsWith('./') ? filePath : `./${filePath}`;

                return {
                    displayPath: rel,
                    absPath: path.resolve(cwd, filePath),
                    type: 'file' as const,
                    matchCount: 0,
                    matches: [],
                    selected: false,
                };
            }));
        },
    });
}

export async function searchContent(query: string, cwd: string): Promise<GrepResult[]> {
    const out: GrepResult[] = [];
    const handle = searchContentStream(query, cwd, (batch) => { out.push(...batch); });
    await handle.done;

    return out;
}

async function loadContentMatches(query: string, absPath: string): Promise<string[]> {
    const lines: string[] = [];
    const handle = streamLines({
        cmd: 'rg',
        args: [
            '-n', '-F', '--no-heading', '--no-filename', '--color=never',
            '-m', String(PREVIEW_MATCH_LIMIT), '--', query, absPath,
        ],
        cwd: process.cwd(),
        maxLines: PREVIEW_MATCH_LIMIT,
        onLines: (batch) => { lines.push(...batch); },
    });
    await handle.done;

    return lines;
}


// ─── Preview helpers ──────────────────────────────────────────────────────────

export async function loadContentPreviewWithMatches(
    absPath: string,
    query: string,
): Promise<ContentPreview> {
    try {
        const raw = await fs.readFile(absPath, 'utf8');
        const lines = raw.split('\n');
        const truncated = lines.length > PREVIEW_MAX_LINES;
        const shown = truncated ? lines.slice(0, PREVIEW_MAX_LINES) : lines;
        const escQuery = query ? escTag(query) : '';
        const HL_OPEN = '{yellow-bg}{black-fg}';
        const HL_CLOSE = '{/black-fg}{/yellow-bg}';
        const gutterWidth = String(shown.length).length;
        let firstMatchLine = -1;
        let matchCount = 0;

        const out = shown.map((line, i) => {
            const lineNo = i + 1;
            // blessed's fullUnicode: true tracks double-width cells via \x03
            // markers; on scroll those markers desync and duplicate glyphs at
            // wrong positions. Sanitize wide / non-printable chars BEFORE
            // tag-escape so the preview renders at exactly one cell per char.
            const safe = sanitizeForBlessed(line);
            const escaped = escTag(safe);
            const hasMatch = escQuery !== '' && line.includes(query);
            if (hasMatch) {
                if (firstMatchLine === -1) firstMatchLine = lineNo;
                // count occurrences in this line (literal substring count)
                let from = 0;
                let idx = line.indexOf(query, from);
                while (idx !== -1) {
                    matchCount++;
                    from = idx + query.length;
                    idx = line.indexOf(query, from);
                }
            }
            const highlighted = (escQuery === '' || !hasMatch)
                ? escaped
                : escaped.split(escQuery).join(`${HL_OPEN}${escQuery}${HL_CLOSE}`);
            const gutter = String(lineNo).padStart(gutterWidth, ' ');
            const gutterTag = hasMatch
                ? `{yellow-fg}${gutter}{/yellow-fg}`
                : `{gray-fg}${gutter}{/gray-fg}`;

            return `${gutterTag}  ${highlighted}`;
        });
        if (truncated) {
            out.push(`{gray-fg}… (truncated at ${PREVIEW_MAX_LINES} lines, file has ${lines.length}){/gray-fg}`);
        }

        return {
            content: out.join('\n'),
            firstMatchLine: firstMatchLine === -1 ? 1 : firstMatchLine,
            totalLines: shown.length,
            matchCount,
        };
    } catch {
        return { content: '(could not read file)', firstMatchLine: 1, totalLines: 1, matchCount: 0 };
    }
}

export async function loadPreview(
    result: GrepResult,
    mode: SearchMode,
    query = '',
): Promise<string> {
    try {
        if (result.type === 'dir') {
            const { stdout } = await execCommand(`ls -la ${JSON.stringify(result.absPath)} 2>/dev/null`);

            return sanitizeForBlessed(stdout) || '(empty directory)';
        }
        if (mode === 'content') {
            if (result.matches.length === 0 && query) {
                result.matches = await loadContentMatches(query, result.absPath);
            }
        if (result.matches.length > 0) {
                return result.matches
                    .map((line) => {
                        const [lineNo, ...rest] = line.split(':');

                        return `{yellow-fg}${lineNo}{/yellow-fg}  ${escTag(sanitizeForBlessed(rest.join(':')))}`;
                    })
                    .join('\n');
            }
        }
        const { stdout } = await execCommand(`head -n 120 ${JSON.stringify(result.absPath)} 2>/dev/null`);

        return sanitizeForBlessed(stdout) || '(binary or empty file)';
    } catch {
        return '(could not read file)';
    }
}

export async function loadMeta(result: GrepResult): Promise<string> {
    try {
        const { stdout: lsOut } = await execCommand(`ls -la ${JSON.stringify(result.absPath)} 2>/dev/null`);
        const { stdout: duOut } = await execCommand(`du -sh ${JSON.stringify(result.absPath)} 2>/dev/null`).catch(() => ({ stdout: '?' }));
        const size = duOut.split('\t')[0] || '?';
        const dir = path.dirname(result.absPath);
        const abs = result.absPath;
        let extra = '';
        if (result.type === 'file') {
            const { stdout: wcOut } = await execCommand(`wc -l ${JSON.stringify(result.absPath)} 2>/dev/null`).catch(() => ({ stdout: '?' }));
            const lineCount = wcOut.trim().split(/\s+/)[0] || '?';
            extra = `\n{cyan-fg}lines  {/cyan-fg}${lineCount}`;
            if (result.matchCount > 0) {
                extra += `\n{cyan-fg}matches{/cyan-fg} {yellow-fg}${result.matchCount}{/yellow-fg}`;
            }
        }

        return (
            `{cyan-fg}path   {/cyan-fg}${escTag(abs)}\n` +
            `{cyan-fg}dir    {/cyan-fg}${escTag(dir)}\n` +
            `{cyan-fg}size   {/cyan-fg}${size}` +
            extra +
            `\n\n{white-fg}${escTag(lsOut.trim())}{/white-fg}`
        );
    } catch {
        return `{cyan-fg}path{/cyan-fg}  ${escTag(result.absPath)}`;
    }
}

// ─── Row renderer ─────────────────────────────────────────────────────────────

export function renderRow(r: GrepResult, mode: SearchMode): string {
    const sel = r.selected ? '{yellow-fg}[x]{/yellow-fg} ' : '    ';
    const icon = r.type === 'dir' ? '📁' : '📄';
    const disp = escTag(r.displayPath.replace(/^\.\//u, ''));
    const countTag = mode === 'content' && r.matchCount > 0
        ? `  {yellow-fg}(${r.matchCount}){/yellow-fg}`
        : '';

    return `${sel}${icon} ${disp}${countTag}`;
}
