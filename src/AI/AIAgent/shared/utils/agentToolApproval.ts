import path from 'path';

export interface ToolWriteRequest {
    contentField: 'content' | 'newContent';
    displayPath: string;
    nextContent: string;
    targetPath: string;
}

export interface EditToolRequest {
    displayPath: string;
    newString: string;
    oldString?: string;
    targetPath: string;
}

export interface EditLinesRequest {
    displayPath: string;
    targetPath: string;
    // Single-edit form
    startLine?: number;
    endLine?: number;
    newContent?: string;
    // Multi-edit (array) form
    startLines?: number[];
    endLines?: number[];
    newContents?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Some agents (notably reasoning models) occasionally JSON-encode array or
// number fields, so we receive `"[1, 5]"` instead of `[1, 5]`. Try to recover
// the structured value before falling back to undefined.
function coerceArray(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;

    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);

            return Array.isArray(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

export function coerceNumberArray(value: unknown): number[] | undefined {
    const arr = coerceArray(value);

    if (!arr) return undefined;

    const out: number[] = [];

    for (const v of arr) {
        if (typeof v === 'number' && Number.isFinite(v)) {
            out.push(v);
        } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
            out.push(Number(v));
        } else {
            return undefined;
        }
    }

    return out;
}

function coerceStringArray(value: unknown): string[] | undefined {
    const arr = coerceArray(value);

    if (!arr) return undefined;

    const out: string[] = [];

    for (const v of arr) {
        if (typeof v === 'string') {
            out.push(v);
        } else {
            return undefined;
        }
    }

    return out;
}

export function coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }

    return undefined;
}

export function getToolArgsRecord(toolArgs: unknown): Record<string, unknown> | undefined {
    if (isRecord(toolArgs)) {
        return toolArgs;
    }

    if (typeof toolArgs === 'string') {
        try {
            const parsed: unknown = JSON.parse(toolArgs);

            return isRecord(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

export function getToolFamily(toolName: string): string {
    return toolName;
}

export function shouldAutoApproveTool(toolName: string): boolean {
    return toolName === 'confirm_task_complete';
}

export function extractWriteRequest(toolArgs: unknown, workspacePath: string): ToolWriteRequest | undefined {
    const args = getToolArgsRecord(toolArgs);

    if (!args) {
        return undefined;
    }

    const rawPath = typeof args.path === 'string'
        ? args.path
        : typeof args.file_path === 'string'
            ? args.file_path
            : typeof args.fileName === 'string'
                ? args.fileName
                : undefined;
    const contentField = typeof args.content === 'string'
        ? 'content'
        : typeof args.newContent === 'string'
            ? 'newContent'
            : undefined;

    if (!rawPath || !contentField) {
        return undefined;
    }

    return {
        contentField,
        displayPath: rawPath,
        nextContent: args[contentField] as string,
        targetPath: path.isAbsolute(rawPath)
            ? rawPath
            : path.join(workspacePath, rawPath),
    };
}

export function extractEditRequest(toolArgs: unknown, workspacePath: string): EditToolRequest | undefined {
    const args = getToolArgsRecord(toolArgs);

    if (!args || typeof args.path !== 'string' || typeof args.new_str !== 'string') {
        return undefined;
    }

    return typeof args.old_str === 'string'
        ? {
            displayPath: args.path,
            newString: args.new_str,
            oldString: args.old_str,
            targetPath: path.isAbsolute(args.path)
                ? args.path
                : path.join(workspacePath, args.path),
        }
        : {
            displayPath: args.path,
            newString: args.new_str,
            targetPath: path.isAbsolute(args.path)
                ? args.path
                : path.join(workspacePath, args.path),
        };
}

export function extractEditLinesRequest(toolArgs: unknown, workspacePath: string): EditLinesRequest | undefined {
    const args = getToolArgsRecord(toolArgs);
    if (!args) return undefined;

    const rawPath = typeof args.file_path === 'string' ? args.file_path : undefined;
    if (!rawPath) return undefined;

    const targetPath = path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath);

    // Multi-edit (array) form — accept real arrays OR JSON-encoded strings.
    const startLines = coerceNumberArray(args.startLines);
    const endLines = coerceNumberArray(args.endLines);
    const newContents = coerceStringArray(args.newContents);

    if (startLines && endLines && newContents) {
        return { displayPath: rawPath, targetPath, startLines, endLines, newContents };
    }

    // Single-edit form
    const startLine = coerceNumber(args.start_line);
    const endLine = coerceNumber(args.end_line);
    const newContent = typeof args.new_content === 'string' ? args.new_content : undefined;

    if (startLine === undefined || endLine === undefined || newContent === undefined) {
        return undefined;
    }

    return { displayPath: rawPath, endLine, newContent, startLine, targetPath };
}

export function buildInsertionOnlyEdit(
    beforeLines: string[],
    afterLines: string[],
    commonPrefixLines: number,
    newSliceStart: number,
    newSliceEnd: number
): { safeLine: number, newContent: string } {
    const safeLine = Math.min(Math.max(commonPrefixLines + 1, 1), Math.max(beforeLines.length, 1));
    const original = beforeLines[safeLine - 1] ?? '';
    const insertedLines = afterLines.slice(newSliceStart, newSliceEnd);

    // Insertions inside the BEFORE file belong before the anchor line; true EOF
    // appends without a trailing newline must keep the last real line first.
    const insertBeforeAnchor = commonPrefixLines < beforeLines.length;
    const replacementLines = insertBeforeAnchor
        ? [...insertedLines, original]
        : [original, ...insertedLines];

    return { safeLine, newContent: replacementLines.join('\n') };
}
