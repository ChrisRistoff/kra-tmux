import * as fs from 'fs/promises';
import { findFunctionRange, getFileOutline } from '../../utils/fileOutline';
import { isBinaryFile, MAX_LINES_PER_CALL } from '../../utils/fileSafety';
import { formatOutlineForMiss, numberLines } from '../format';
import { markRead } from '../readCache';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleReadFunction(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
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

        return textContent(`Lines ${range.start}\u2013${range.end}:\n\n${numbered}`);
    } catch (err) {
        return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    }
}
