import * as fs from 'fs/promises';
import { coerceNumber, coerceNumberArray, coerceStringArray } from '../args';
import { atomicWriteFile } from '../../utils/fileSafety';
import {
    LARGE_RANGE_THRESHOLD,
    clearReadCache,
} from '../readCache';
import { withDiagnostics } from '../format';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleEditLines(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
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
