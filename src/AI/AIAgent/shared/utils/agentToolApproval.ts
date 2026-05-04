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

export interface AnchorEdit {
    op: 'replace' | 'insert' | 'delete';
    anchor: string;
    endAnchor: string | undefined;
    position: 'before' | 'after' | undefined;
    content: string | undefined;
}

export interface AnchorEditRequest {
    displayPath: string;
    targetPath: string;
    edits: AnchorEdit[];
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

export function extractAnchorEditRequest(toolArgs: unknown, workspacePath: string): AnchorEditRequest | undefined {
    const args = getToolArgsRecord(toolArgs);
    if (!args) return undefined;

    const rawPath = typeof args.file_path === 'string' ? args.file_path : undefined;
    if (!rawPath) return undefined;

    const targetPath = path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath);

    const editsRaw = coerceArray(args.edits);
    if (!editsRaw || editsRaw.length === 0) return undefined;

    const edits: AnchorEdit[] = [];

    for (const raw of editsRaw) {
        if (!isRecord(raw)) return undefined;

        const op = raw.op;
        if (op !== 'replace' && op !== 'insert' && op !== 'delete') return undefined;

        const anchor = typeof raw.anchor === 'string' ? raw.anchor : undefined;
        if (!anchor) return undefined;

        const endAnchor = typeof raw.end_anchor === 'string' ? raw.end_anchor : undefined;
        const position = raw.position === 'before' || raw.position === 'after' ? raw.position : undefined;
        const content = typeof raw.content === 'string' ? raw.content : undefined;

        edits.push({ op, anchor, endAnchor, position, content });
    }

    return { displayPath: rawPath, targetPath, edits };
}