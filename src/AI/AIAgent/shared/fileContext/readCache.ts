import * as path from 'path';

/**
 * Per-session read-before-edit tracker.
 *
 * edit_lines refuses to touch lines the agent has not read via read_lines /
 * read_function / create_file in the same session. The cache is cleared per
 * file after each successful edit_lines or create_file, since prior line
 * numbers may shift.
 */

// Hard cap on a single edit_lines range. There is intentionally NO override
// flag of any kind \u2014 neither agents nor MCP clients can bypass this. Larger
// changes must be split into multiple ranges (multi-edit array form counts
// each range separately).
export const LARGE_RANGE_THRESHOLD = 100;

// Soft gate: if a single read_lines call requests more than this many lines
// (summed across ranges), return the file's outline instead of raw content
// so the AI can pick a tighter range. Pure range-based \u2014 no per-file state.
export const LARGE_READ_THRESHOLD = 200;

const seenLines = new Map<string, Set<number>>();

export function canonicalPath(p: string): string {
    return path.resolve(p);
}

export function markRead(filePath: string, start: number, end: number): void {
    const key = canonicalPath(filePath);
    let s = seenLines.get(key);

    if (!s) {
        s = new Set();
        seenLines.set(key, s);
    }

    for (let i = start; i <= end; i++) s.add(i);
}

export function findUnreadGap(filePath: string, start: number, end: number): [number, number] | undefined {
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

export function clearReadCache(filePath: string): void {
    seenLines.delete(canonicalPath(filePath));
}
