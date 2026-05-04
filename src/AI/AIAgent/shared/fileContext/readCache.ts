import * as path from 'path';

/**
 * Per-file read tracker. Currently used by read_lines / read_function /
 * create_file to remember which lines the agent has already seen, and cleared
 * by `edit` and create_file after a successful write. The new anchor-based
 * `edit` tool no longer requires read-before-edit (the anchor itself proves
 * the agent has seen the surrounding code), so this is now informational
 * rather than a gate.
 */

// Retained for back-compat with utilities that historically gated edits by
// The new anchor-based `edit` tool has no per-range cap (the replaced region
// is bounded by content the agent named explicitly).
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

// Not currently in use. Left here for tools that may want to flag edits to
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
