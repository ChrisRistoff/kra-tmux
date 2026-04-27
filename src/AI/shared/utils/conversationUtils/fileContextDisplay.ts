import fs from 'fs/promises';
import type { FileContext } from '@/AI/shared/types/aiTypes';
import { getContextFileName, getContextLineRange } from './fileContextStore';

async function readFileStats(filePath: string): Promise<{ lineCount: number; sizeKB: number } | null> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');

        return {
            lineCount: content.split('\n').length,
            sizeKB: Math.round(content.length / 1024),
        };
    } catch {
        return null;
    }
}

export function formatContextSummary(context: FileContext): string {
    const fileName = getContextFileName(context.filePath);

    if (!context.isPartial) {
        return `${fileName} (full file)`;
    }

    const lineRange = getContextLineRange(context.startLine, context.endLine);

    return `${fileName} (${lineRange})`;
}

export async function formatContextPickerItem(context: FileContext, index: number): Promise<string> {
    const fileName = getContextFileName(context.filePath);

    if (context.isPartial) {
        const lineRange = getContextLineRange(context.startLine, context.endLine);

        return `${index + 1}. 📄 ${fileName} (${lineRange})`;
    }

    const stats = await readFileStats(context.filePath);
    if (!stats) {
        return `${index + 1}. ❌ ${fileName} (error reading file)`;
    }

    return `${index + 1}. 📁 ${fileName} (${stats.lineCount} lines, ${stats.sizeKB}KB)`;
}

export async function formatContextPopupEntry(context: FileContext, index: number): Promise<string[]> {
    const fileName = getContextFileName(context.filePath);

    if (context.isPartial) {
        const lineRange = getContextLineRange(context.startLine, context.endLine);

        return [`${index + 1}. 📄 ${fileName} (${lineRange})`, `   ${context.filePath}`, ''];
    }

    const stats = await readFileStats(context.filePath);
    if (!stats) {
        return [`${index + 1}. ❌ ${fileName} (error reading file)`, `   ${context.filePath}`, ''];
    }

    return [
        `${index + 1}. 📁 ${fileName} (${stats.lineCount} lines, ${stats.sizeKB}KB)`,
        `   ${context.filePath}`,
        '',
    ];
}
