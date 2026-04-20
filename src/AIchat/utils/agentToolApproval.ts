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
    endLine: number;
    newContent: string;
    startLine: number;
    targetPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    return toolName === 'report_intent';
}

export function extractWriteRequest(toolArgs: unknown, workspacePath: string): ToolWriteRequest | undefined {
    const args = getToolArgsRecord(toolArgs);

    if (!args) {
        return undefined;
    }

    const rawPath = typeof args.path === 'string'
        ? args.path
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
    const startLine = typeof args.start_line === 'number' ? args.start_line : undefined;
    const endLine = typeof args.end_line === 'number' ? args.end_line : undefined;
    const newContent = typeof args.new_content === 'string' ? args.new_content : undefined;

    if (!rawPath || startLine === undefined || endLine === undefined || newContent === undefined) {
        return undefined;
    }

    return {
        displayPath: rawPath,
        endLine,
        newContent,
        startLine,
        targetPath: path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath, rawPath),
    };
}
