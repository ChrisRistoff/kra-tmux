import { errorContent, ToolResult } from './toolResult';
import { handleCreateFile } from './handlers/createFile';
import { handleEditLines } from './handlers/editLines';
import { handleGetOutline } from './handlers/getOutline';
import { handleLspQuery } from './handlers/lspQuery';
import { handleReadFunction } from './handlers/readFunction';
import { handleReadLines } from './handlers/readLines';
import { handleSearch } from './handlers/search';

/**
 * Dispatches a tool call to the appropriate handler. Tools that take a
 * `file_path` are validated centrally so each handler can assume non-empty.
 */
export async function dispatchFileContextTool(
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    if (name === 'lsp_query') {
        return handleLspQuery(args);
    }

    if (name === 'search') {
        return handleSearch(args);
    }

    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined;

    if (!filePath) return errorContent('file_path argument is required.');

    switch (name) {
        case 'get_outline':
            return handleGetOutline(filePath);

        case 'read_lines':
            return handleReadLines(filePath, args);

        case 'read_function':
            return handleReadFunction(filePath, args);

        case 'edit_lines':
            return handleEditLines(filePath, args);

        case 'create_file':
            return handleCreateFile(filePath, args);

        default:
            return errorContent(`Unknown tool: ${name}`);
    }
}
