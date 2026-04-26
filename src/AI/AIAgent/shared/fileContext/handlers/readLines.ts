import * as fs from 'fs/promises';
import { coerceNumber, coerceNumberArray } from '../args';
import { formatOutline, getFileOutline } from '../../utils/fileOutline';
import { isBinaryFile, MAX_LINES_PER_CALL } from '../../utils/fileSafety';
import { LARGE_READ_THRESHOLD, markRead } from '../readCache';
import { numberLines, totalRequestedLines } from '../format';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleReadLines(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
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
        // Soft gate: large reads get bounced to the outline so the AI can
        // pick a tighter range. Skipped for files with no recognisable
        // structure (plain text, JSON, logs) where an outline would be
        // empty and unhelpful.
        if (totalLines > LARGE_READ_THRESHOLD) {
            const outline = await getFileOutline(filePath);
            const hasStructure = outline.entries.length > 0 || !!outline.imports;

            if (hasStructure) {
                return errorContent(
                    `Requested ${totalLines} lines in one call, exceeds the soft cap of ${LARGE_READ_THRESHOLD}. ` +
                    `Use the outline below to pick a tighter range, then retry read_lines.\n\n` +
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
