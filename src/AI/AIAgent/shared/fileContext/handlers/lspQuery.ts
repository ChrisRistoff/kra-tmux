import { runLspQuery, LspOp, LspQueryArgs } from '../../utils/lspQueryHandler';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleLspQuery(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    const op = args.op as LspOp;
    const queryArgs: LspQueryArgs = { file_path: filePath, op };

    if (typeof args.line === 'number') queryArgs.line = args.line;
    if (typeof args.col === 'number') queryArgs.col = args.col;
    if (typeof args.symbol === 'string') queryArgs.symbol = args.symbol;
    if (typeof args.occurrence === 'number') queryArgs.occurrence = args.occurrence;
    if (typeof args.include_declaration === 'boolean') queryArgs.include_declaration = args.include_declaration;

    try {
        const text = await runLspQuery(queryArgs);

        return textContent(text);
    } catch (err) {
        return errorContent(`lsp_query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
