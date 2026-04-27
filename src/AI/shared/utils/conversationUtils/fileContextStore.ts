import { fileTypes } from '@/AI/shared/data/filetypes';
import type { FileContext } from '@/AI/shared/types/aiTypes';

export const fileContexts: FileContext[] = [];

export function clearStoredFileContexts(): void {
    fileContexts.length = 0;
}

export function upsertFileContext(ctx: FileContext): void {
    const existingIndex = ctx.isPartial
        ? fileContexts.findIndex(
            (candidate) =>
                candidate.filePath === ctx.filePath &&
                candidate.startLine === ctx.startLine &&
                candidate.endLine === ctx.endLine
        )
        : fileContexts.findIndex((candidate) => candidate.filePath === ctx.filePath);

    if (existingIndex >= 0) {
        fileContexts[existingIndex] = ctx;

        return;
    }

    fileContexts.push(ctx);
}

export function getFileExtension(filename: string): string {
    const idx = filename.lastIndexOf('.');

    if (idx === -1) return 'text';

    const ext = filename.slice(idx + 1).toLowerCase();

    return fileTypes[ext] || ext || 'text';
}

export function getContextFileName(filePath: string): string {
    return filePath.split('/').pop() ?? filePath;
}

export function getContextLineRange(startLine: number | undefined, endLine: number | undefined): string {
    if (typeof startLine !== 'number' || typeof endLine !== 'number') {
        return 'unknown range';
    }

    return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}
