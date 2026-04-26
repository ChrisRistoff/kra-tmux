import { coerceNumber } from '../args';
import {
    SEARCH_DEFAULT_MAX_RESULTS,
    SEARCH_HARD_CAP_MAX_RESULTS,
    SearchOpts,
    searchContent,
    searchNameOnly,
} from '../rgSearch';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const namePattern = typeof args.name_pattern === 'string' && args.name_pattern.length > 0
        ? args.name_pattern
        : undefined;
    const contentPattern = typeof args.content_pattern === 'string' && args.content_pattern.length > 0
        ? args.content_pattern
        : undefined;

    if (!namePattern && !contentPattern) {
        return errorContent('Provide name_pattern, content_pattern, or both. At least one is required.');
    }

    const rootPath = typeof args.path === 'string' && args.path.length > 0 ? args.path : process.cwd();
    const type = typeof args.type === 'string' && args.type.length > 0 ? args.type : undefined;
    const caseInsensitive = args.case_insensitive === true;
    const contextRaw = coerceNumber(args.context);
    const context = contextRaw && contextRaw > 0 ? Math.floor(contextRaw) : 0;
    const multiline = args.multiline === true;
    const maxRaw = coerceNumber(args.max_results);
    const maxResults = Math.min(
        SEARCH_HARD_CAP_MAX_RESULTS,
        maxRaw && maxRaw > 0 ? Math.floor(maxRaw) : SEARCH_DEFAULT_MAX_RESULTS,
    );

    const opts: SearchOpts = {
        namePattern,
        contentPattern,
        rootPath,
        type,
        caseInsensitive,
        context,
        multiline,
        maxResults,
    };

    try {
        const out = contentPattern
            ? await searchContent(opts)
            : await searchNameOnly(opts);

        return textContent(out);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes('ENOENT')) {
            return errorContent('ripgrep (rg) not found on PATH. Install ripgrep to use the search tool.');
        }

        return errorContent(`search failed: ${msg}`);
    }
}
