import * as fs from 'fs/promises';
import { atomicWriteFile } from '../../utils/fileSafety';
import { coerceArray } from '../args';
import { withDiagnostics } from '../format';
import { errorContent, textContent, ToolResult } from '../toolResult';
import { clearReadCache } from '../readCache';

/**
 * Anchor-based file editor.
 *
 * The agent never specifies absolute line numbers. Every line that is removed
 * from disk is bounded by content that the agent named explicitly:
 *
 *   - replace / delete with a single `anchor` → operates on that anchor block.
 *   - replace / delete with `anchor` + `end_anchor` → operates on the range
 *     between (and including) the two anchor blocks.
 *   - insert with `anchor` + `position` → adds new content adjacent to the
 *     anchor block; nothing is removed.
 *
 * Anchors are matched as a contiguous run of one or more whole lines. They
 * must resolve to exactly one location in the file or the call is rejected
 * before any disk write.
 */

type Op = 'replace' | 'insert' | 'delete';
type Position = 'before' | 'after';

interface ParsedEdit {
    index: number;
    op: Op;
    anchor: string[];           // one or more lines, already split
    endAnchor?: string[];       // optional, replace/delete only
    position?: Position;        // insert only (default 'after')
    content?: string;           // replace + insert; undefined for delete
}

interface ResolvedEdit extends ParsedEdit {
    anchorStart: number;        // 0-based index of the first line of the anchor block
    anchorEnd: number;          // 0-based index of the last line of the anchor block (inclusive)
    endAnchorStart: number | undefined;    // populated when endAnchor is present
    endAnchorEnd: number | undefined;
    matchedTrimmed: boolean;    // true if the anchor only matched after whitespace fallback
    endMatchedTrimmed: boolean; // ditto for endAnchor
    affectedStart: number;      // first 0-based line that this edit touches/inserts at
    affectedEnd: number;        // last 0-based line touched (== affectedStart - 1 for inserts)
    insertAt: number | undefined;          // 0-based line index where insert content is spliced in
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitAnchor(raw: string): string[] {
    // Trim trailing newlines (a single \n at the end is the most common
    // accidental inclusion when the agent copied from a file view) but
    // preserve internal newlines so multi-line anchors keep their shape.
    const stripped = raw.replace(/\n+$/, '');

    return stripped.split('\n');
}

function isBlank(lines: string[]): boolean {
    return lines.every(l => l.trim() === '');
}

function findExactMatches(haystack: string[], needle: string[]): number[] {
    const out: number[] = [];
    const limit = haystack.length - needle.length;

    if (limit < 0) return out;

    outer:
    for (let i = 0; i <= limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }

        out.push(i);
    }

    return out;
}

function findTrimmedMatches(haystack: string[], needle: string[]): number[] {
    const out: number[] = [];
    const trimmedNeedle = needle.map(l => l.trim());
    const limit = haystack.length - needle.length;

    if (limit < 0) return out;

    outer:
    for (let i = 0; i <= limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j].trim() !== trimmedNeedle[j]) continue outer;
        }

        out.push(i);
    }

    return out;
}

interface ResolveResult {
    start: number;
    matchedTrimmed: boolean;
    error?: string;
}

function describeMatchContext(haystack: string[], idx: number): string {
    const lineNo = idx + 1;
    const line = haystack[idx] ?? '';
    const snippet = line.length > 80 ? line.slice(0, 77) + '...' : line;

    return `line ${lineNo}: ${snippet}`;
}

function fuzzyCandidates(haystack: string[], needleFirst: string, max = 3): string[] {
    const target = needleFirst.trim();

    if (!target) return [];

    const scored: { idx: number; score: number }[] = [];

    for (let i = 0; i < haystack.length; i++) {
        const line = haystack[i].trim();

        if (!line) continue;

        // Cheap token-overlap score: count of shared whitespace-separated tokens.
        const tt = new Set(target.split(/\s+/).filter(Boolean));
        const lt = line.split(/\s+/).filter(Boolean);
        let shared = 0;

        for (const t of lt) if (tt.has(t)) shared++;

        if (shared === 0 && !line.includes(target) && !target.includes(line)) continue;

        scored.push({ idx: i, score: shared });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, max).map(({ idx }) => `  - ${describeMatchContext(haystack, idx)}`);
}

function resolveAnchor(
    haystack: string[],
    needle: string[],
    label: string,
): ResolveResult {
    const exact = findExactMatches(haystack, needle);

    if (exact.length === 1) {
        return { start: exact[0], matchedTrimmed: false };
    }

    if (exact.length === 0) {
        const trimmed = findTrimmedMatches(haystack, needle);

        if (trimmed.length === 1) {
            return { start: trimmed[0], matchedTrimmed: true };
        }

        if (trimmed.length === 0) {
            const hints = fuzzyCandidates(haystack, needle[0]);
            const hintBlock = hints.length > 0
                ? `\nNearest lines in the file:\n${hints.join('\n')}`
                : '';

            return {
                start: -1,
                matchedTrimmed: false,
                error: `${label} not found in the file. Re-read the area you want to edit, then retry with an anchor that copies the line(s) verbatim.${hintBlock}`,
            };
        }

        // trimmed > 1 — ambiguous even after relaxing whitespace.
        const matches = trimmed.slice(0, 5).map(i => `  - ${describeMatchContext(haystack, i)}`).join('\n');

        return {
            start: -1,
            matchedTrimmed: false,
            error: `${label} matched ${trimmed.length} locations after whitespace-trim and is ambiguous. Add an adjacent line above or below to make it unique.\nMatches:\n${matches}`,
        };
    }

    // exact > 1
    const matches = exact.slice(0, 5).map(i => `  - ${describeMatchContext(haystack, i)}`).join('\n');

    return {
        start: -1,
        matchedTrimmed: false,
        error: `${label} matched ${exact.length} locations and is ambiguous. Add an adjacent line above or below to make it unique.\nMatches:\n${matches}`,
    };
}

function parseEdit(raw: unknown, index: number): ParsedEdit | string {
    if (!isObject(raw)) return `edits[${index}] must be an object.`;

    const opVal = raw.op;
    const op = opVal === 'replace' || opVal === 'insert' || opVal === 'delete' ? opVal : undefined;

    if (!op) return `edits[${index}].op must be one of "replace", "insert", "delete".`;

    if (typeof raw.anchor !== 'string' || raw.anchor === '') {
        return `edits[${index}].anchor is required and must be a non-empty string.`;
    }

    const anchor = splitAnchor(raw.anchor);

    if (anchor.length === 0 || isBlank(anchor)) {
        return `edits[${index}].anchor cannot be blank or whitespace-only — pick a non-blank line that uniquely identifies the location.`;
    }

    const parsed: ParsedEdit = { index, op, anchor };

    if (op === 'insert') {
        const pos = raw.position;

        if (pos !== undefined && pos !== 'before' && pos !== 'after') {
            return `edits[${index}].position must be "before" or "after" (default "after").`;
        }

        parsed.position = pos === 'before' ? 'before' : 'after';

        if (typeof raw.content !== 'string') {
            return `edits[${index}].content is required for insert (use "" to insert nothing, though that is a no-op).`;
        }

        parsed.content = raw.content;

        if (raw.end_anchor !== undefined) {
            return `edits[${index}].end_anchor is not allowed for insert. Use replace/delete with a range, or insert before/after a single anchor.`;
        }

        return parsed;
    }

    if (raw.end_anchor !== undefined) {
        if (typeof raw.end_anchor !== 'string' || raw.end_anchor === '') {
            return `edits[${index}].end_anchor must be a non-empty string when provided.`;
        }

        const endAnchor = splitAnchor(raw.end_anchor);

        if (endAnchor.length === 0 || isBlank(endAnchor)) {
            return `edits[${index}].end_anchor cannot be blank or whitespace-only.`;
        }

        parsed.endAnchor = endAnchor;
    }

    if (op === 'replace') {
        if (typeof raw.content !== 'string') {
            return `edits[${index}].content is required for replace (use "" to delete the matched range, or use op:"delete").`;
        }

        parsed.content = raw.content;
    }

    if (raw.position !== undefined) {
        return `edits[${index}].position is only valid for insert.`;
    }

    return parsed;
}

function rangesOverlap(a: ResolvedEdit, b: ResolvedEdit): boolean {
    // For inserts, affectedEnd === affectedStart - 1, so the range is empty.
    // We still want to reject two inserts at the same position (ambiguous order)
    // and an insert that lands inside another edit's replaced range.
    const aStart = a.op === 'insert' ? (a.insertAt as number) : a.affectedStart;
    const aEnd = a.op === 'insert' ? (a.insertAt as number) : a.affectedEnd;
    const bStart = b.op === 'insert' ? (b.insertAt as number) : b.affectedStart;
    const bEnd = b.op === 'insert' ? (b.insertAt as number) : b.affectedEnd;

    if (a.op === 'insert' && b.op === 'insert') {
        return aStart === bStart;
    }

    // For mixed/replace pairs: any intersection is a conflict.
    return aStart <= bEnd && bStart <= aEnd;
}

function describeRange(start: number, end: number): string {
    return start === end ? `line ${start + 1}` : `lines ${start + 1}\u2013${end + 1}`;
}

function summarizeEdit(e: ResolvedEdit): string {
    const note = e.matchedTrimmed || e.endMatchedTrimmed ? ' (matched after whitespace-trim)' : '';

    if (e.op === 'insert') {
        const inserted = e.content === '' ? 0 : (e.content as string).split('\n').length;
        const at = (e.insertAt as number) + 1;
        const direction = e.position === 'before' ? 'before' : 'after';

        return `Inserted ${inserted} line${inserted === 1 ? '' : 's'} ${direction} ${describeRange(e.anchorStart, e.anchorEnd)}${note} (now at line ${at}).`;
    }

    const removed = e.affectedEnd - e.affectedStart + 1;

    if (e.op === 'delete') {
        return `Deleted ${removed} line${removed === 1 ? '' : 's'} (${describeRange(e.affectedStart, e.affectedEnd)})${note}.`;
    }

    const inserted = e.content === '' ? 0 : (e.content as string).split('\n').length;

    return `Replaced ${removed} line${removed === 1 ? '' : 's'} (${describeRange(e.affectedStart, e.affectedEnd)}) with ${inserted} line${inserted === 1 ? '' : 's'}${note}.`;
}

export async function handleEdit(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
    const editsArr = coerceArray(args.edits);

    if (!editsArr || editsArr.length === 0) {
        return errorContent('edits must be a non-empty array of edit objects.');
    }

    const parsed: ParsedEdit[] = [];

    for (let i = 0; i < editsArr.length; i++) {
        const result = parseEdit(editsArr[i], i);

        if (typeof result === 'string') return errorContent(result);

        parsed.push(result);
    }

    let raw: string;

    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
        return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    }

    const lines = raw.split('\n');

    // Resolve all anchors against the ORIGINAL file (parallel resolution).
    // This makes edits independent of each other's effects within the same call.
    const resolved: ResolvedEdit[] = [];

    for (const e of parsed) {
        const anchorRes = resolveAnchor(lines, e.anchor, `edits[${e.index}].anchor`);

        if (anchorRes.error) return errorContent(anchorRes.error);

        const anchorStart = anchorRes.start;
        const anchorEnd = anchorStart + e.anchor.length - 1;

        let endAnchorStart: number | undefined;
        let endAnchorEnd: number | undefined;
        let endMatchedTrimmed = false;

        if (e.endAnchor) {
            const endRes = resolveAnchor(lines, e.endAnchor, `edits[${e.index}].end_anchor`);

            if (endRes.error) return errorContent(endRes.error);

            endAnchorStart = endRes.start;
            endAnchorEnd = endAnchorStart + e.endAnchor.length - 1;
            endMatchedTrimmed = endRes.matchedTrimmed;

            if (endAnchorStart < anchorStart) {
                return errorContent(
                    `edits[${e.index}].end_anchor (matched at line ${endAnchorStart + 1}) appears before anchor (matched at line ${anchorStart + 1}). Swap them or pick different anchors.`
                );
            }
        }

        let affectedStart: number;
        let affectedEnd: number;
        let insertAt: number | undefined;

        if (e.op === 'insert') {
            insertAt = e.position === 'before' ? anchorStart : anchorEnd + 1;
            affectedStart = insertAt;
            affectedEnd = insertAt - 1; // empty range
        } else {
            affectedStart = anchorStart;
            affectedEnd = endAnchorEnd ?? anchorEnd;
        }

        resolved.push({
            ...e,
            anchorStart,
            anchorEnd,
            endAnchorStart,
            endAnchorEnd,
            matchedTrimmed: anchorRes.matchedTrimmed,
            endMatchedTrimmed,
            affectedStart,
            affectedEnd,
            insertAt,
        });
    }

    // Detect overlaps before mutating anything.
    const sorted = [...resolved].sort((a, b) => a.affectedStart - b.affectedStart);

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];

        if (rangesOverlap(prev, curr)) {
            return errorContent(
                `edits[${prev.index}] and edits[${curr.index}] target overlapping or identical regions of the file. Combine them into one edit, or pick non-conflicting anchors.`
            );
        }
    }

    // Apply bottom-to-top so earlier line indices stay valid.
    const applyOrder = [...resolved].sort((a, b) => b.affectedStart - a.affectedStart);
    let working = lines;

    for (const e of applyOrder) {
        const insertLines = e.op === 'delete' || e.content === '' || e.content === undefined
            ? []
            : e.content.split('\n');

        if (e.op === 'insert') {
            const at = e.insertAt as number;

            working = [...working.slice(0, at), ...insertLines, ...working.slice(at)];
        } else {
            working = [
                ...working.slice(0, e.affectedStart),
                ...insertLines,
                ...working.slice(e.affectedEnd + 1),
            ];
        }
    }

    try {
        await atomicWriteFile(filePath, working.join('\n'));
        clearReadCache(filePath);
    } catch (err) {
        return errorContent(`Could not write file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Report summaries in original edit order so the agent can correlate.
    const summaries = resolved
        .slice()
        .sort((a, b) => a.index - b.index)
        .map(summarizeEdit)
        .join('\n');

    return textContent(await withDiagnostics(filePath, summaries));
}
