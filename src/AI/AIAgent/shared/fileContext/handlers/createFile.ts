import * as fs from 'fs/promises';
import { atomicWriteFile } from '../../utils/fileSafety';
import { clearReadCache, markRead } from '../readCache';
import { withDiagnostics } from '../format';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleCreateFile(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
    const content = typeof args.content === 'string' ? args.content : undefined;

    if (content === undefined) return errorContent('content argument is required.');

    // create_file is for NEW files only. Modifications to existing files must
    // go through edit_lines (multi-range form for changes spanning multiple
    // regions). This prevents bypassing the edit_lines cap by overwriting.
    let exists = false;

    try {
        await fs.access(filePath);
        exists = true;
    } catch { /* does not exist */ }

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
