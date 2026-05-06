import * as path from 'path';
import { errorContent, ToolResult } from './toolResult';
import { handleCreateFile } from './handlers/createFile';
import { handleEdit } from './handlers/edit';
import { handleGetOutline } from './handlers/getOutline';
import { handleLspQuery } from './handlers/lspQuery';
import { handleReadFunction } from './handlers/readFunction';
import { handleReadLines } from './handlers/readLines';
import { handleSearch } from './handlers/search';

/**
 * Resolve a tool-supplied path against the primary repo (WORKING_DIR).
 * Absolute paths pass through unchanged — this is how the agent targets
 * non-primary repos in a multi-repo workspace.
 */
function normalizePath(p: string): string {
    if (path.isAbsolute(p)) return p;
    const root = process.env['WORKING_DIR'] ?? process.cwd();

    return path.resolve(root, p);
}

/**
 * Dispatches a tool call to the appropriate handler. Tools that take a
 * `file_path` are validated centrally so each handler can assume non-empty.
 */
export async function dispatchFileContextTool(
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    if (name === 'lsp_query') {
        const fp = typeof args.file_path === 'string' ? args.file_path : '';

        return handleLspQuery({ ...args, file_path: fp ? normalizePath(fp) : '' });
    }

    if (name === 'search') {
        const p = typeof args.path === 'string' && args.path.length > 0 ? args.path : '';

        return handleSearch({ ...args, ...(p ? { path: normalizePath(p) } : {}) });
    }

    const rawFilePath = typeof args.file_path === 'string' ? args.file_path : undefined;

    if (!rawFilePath) return errorContent('file_path argument is required.');
    const filePath = normalizePath(rawFilePath);

    switch (name) {
        case 'get_outline':
            return handleGetOutline(filePath);

        case 'read_lines':
            return handleReadLines(filePath, args);

        case 'read_function':
            return handleReadFunction(filePath, args);

        case 'anchor_edit':
            return handleEdit(filePath, args);

        case 'create_file':
            return handleCreateFile(filePath, args);

        default:
            return errorContent(`Unknown tool: ${name}`);
    }
}
