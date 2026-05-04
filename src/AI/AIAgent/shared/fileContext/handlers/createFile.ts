import * as fs from 'fs/promises';
import { atomicWriteFile } from '../../utils/fileSafety';
import { clearReadCache, markRead } from '../readCache';
import { withDiagnostics } from '../format';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleCreateFile(filePath: string, args: Record<string, unknown>): Promise<ToolResult> {
    const content = typeof args.content === 'string' ? args.content : undefined;

    if (content === undefined) return errorContent('content argument is required.');

    // create_file is for NEW files only. Modifications to existing files must
    // go through the anchor-based `edit` tool.
    let exists = false;

    try {
        await fs.access(filePath);
        exists = true;
    } catch { /* does not exist */ }

    if (exists) {
        return errorContent(
            `Refusing to create_file: ${filePath} already exists. Use the \`edit\` tool to modify existing files ` +
            '(pass several entries in `edits` for changes spanning multiple regions).'
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
