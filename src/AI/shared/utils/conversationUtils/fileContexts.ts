import fs from 'fs/promises';
import { fileContexts, getFileExtension, clearStoredFileContexts } from './fileContextStore';

export { fileContexts, getFileExtension };

export const clearFileContexts = (): void => {
    clearStoredFileContexts();
};

/**
 * Generate context string for AI prompt from loaded file contexts.
 */
export async function getFileContextsForPrompt(): Promise<string> {
    if (fileContexts.length === 0) return '';

    let contextString = '\n\n--- FILE CONTEXTS ---\nThe following files have been provided as context for this conversation:\n\n';

    for (const context of fileContexts) {
        try {
            if (context.isPartial) continue;
            const content = await fs.readFile(context.filePath, 'utf-8');
            contextString += `File: ${context.filePath} (complete file)\n${content}\n\n---\n\n`;
        } catch (error) {
            console.error(`Error loading context for ${context.filePath}:`, error);
            contextString += `File: ${context.filePath}\n// Error: Could not load file\n\n---\n\n`;
        }
    }

    return contextString;
}

/**
 * Generate a metadata-only `<tagged_files>` block describing the loaded file
 * contexts (path + line count for full files, path + line range for partial
 * selections). The model is expected to read the actual contents on demand
 * via its file-reading tools.
 */
export async function getFileContextsTaggedBlock(): Promise<string> {
    if (fileContexts.length === 0) return '';

    const lines: string[] = [];

    for (const context of fileContexts) {
        if (context.isPartial) {
            const start = context.startLine;
            const end = context.endLine;
            const range = typeof start === 'number' && typeof end === 'number'
                ? (start === end ? `line ${start}` : `lines ${start}-${end}`)
                : 'partial selection';
            lines.push(`* ${context.filePath} (${range})`);
            continue;
        }

        try {
            const content = await fs.readFile(context.filePath, 'utf-8');
            const count = content.length === 0 ? 0 : content.split('\n').length;
            lines.push(`* ${context.filePath} (${count} lines)`);
        } catch (error) {
            console.error(`Error loading context for ${context.filePath}:`, error);
            lines.push(`* ${context.filePath}`);
        }
    }

    return `<tagged_files>\n${lines.join('\n')}\n</tagged_files>`;
}

export async function rebuildFileContextsFromChat(chatFile: string): Promise<void> {
    try {
        const content = await fs.readFile(chatFile, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('📁 ')) continue;

            const fileName = lines[i].substring(2, lines[i].indexOf(' ('));
            let j = i + 1;
            while (j < lines.length && !lines[j].startsWith('```')) j++;
            if (j >= lines.length) continue;

            j++;
            while (j < lines.length && !lines[j].startsWith('// Full file content loaded: ') && !lines[j].startsWith('// Selected from: ')) j++;
            if (j >= lines.length) continue;

            if (lines[j].startsWith('// Full file content loaded: ')) {
                const filePath = lines[j].substring('// Full file content loaded: '.length).trim();
                fileContexts.push({ filePath, isPartial: false, summary: `Full file: ${fileName}` });
            } else if (lines[j].startsWith('// Selected from: ')) {
                const fileInfo = lines[j].substring('// Selected from: '.length).trim();
                const filePath = fileInfo.substring(0, fileInfo.indexOf(' ('));
                const lineMatch = fileInfo.match(/\((lines? (\d+)-(\d+)|line (\d+))\)/);

                let startLine, endLine;
                if (lineMatch) {
                    [startLine, endLine] = lineMatch[4]
                        ? [parseInt(lineMatch[4]), parseInt(lineMatch[4])]
                        : [parseInt(lineMatch[2]), parseInt(lineMatch[3])];
                }

                fileContexts.push({ filePath, isPartial: true, startLine, endLine, summary: `Partial file: ${fileName}` });
            }
        }
    } catch (error) {
        console.error('Error rebuilding file contexts:', error);
    }
}
