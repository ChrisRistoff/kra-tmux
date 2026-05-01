#!/usr/bin/env node
/**
 * kra-web MCP server — exposes `web_fetch` and `web_search` to BYOK agents.
 *
 * Mirrors the JSON-RPC stdio pattern used by bashMcpServer.ts so we have no
 * extra runtime dependency. The actual fetch / search implementations live
 * in `src/AI/shared/utils/webTools.ts` so AIChat (in-process tool calling)
 * and BYOK (out-of-process MCP) share the same code.
 */

import 'module-alias/register';

import { JsonRpcToolError, runStdioMcpServer } from '../../mcp/stdioServer';
import {
    runWebFetch,
    runWebSearch,
    WEB_FETCH_DESCRIPTION,
    WEB_FETCH_PARAMETERS,
    WEB_SEARCH_DESCRIPTION,
    WEB_SEARCH_PARAMETERS,
    type WebFetchArgs,
    type WebSearchArgs,
} from '@/AI/shared/utils/webTools';

const WEB_FETCH_TOOL = {
    name: 'web_fetch',
    description: WEB_FETCH_DESCRIPTION,
    inputSchema: WEB_FETCH_PARAMETERS,
};

const WEB_SEARCH_TOOL = {
    name: 'web_search',
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: WEB_SEARCH_PARAMETERS,
};

const TOOLS = [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];

runStdioMcpServer({
    serverName: 'kra-web',
    tools: TOOLS,
    handleToolCall: async ({ toolName, params }) => {
        const callParams = (params ?? {}) as { arguments?: unknown };
        const rawArgs = callParams.arguments;
        const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Partial<WebFetchArgs & WebSearchArgs>;

        if (toolName === 'web_fetch') {
            if (typeof args.url !== 'string') {
                throw new JsonRpcToolError(-32602, 'Missing required argument: url');
            }

            const { output, isError } = await runWebFetch({
                url: args.url,
                ...(args.max_length !== undefined ? { max_length: args.max_length } : {}),
            });

            return {
                content: [{ type: 'text', text: output }],
                isError,
            };
        }

        if (toolName === 'web_search') {
            if (typeof args.query !== 'string') {
                throw new JsonRpcToolError(-32602, 'Missing required argument: query');
            }

            const { output, isError } = await runWebSearch({
                query: args.query,
                ...(args.max_results !== undefined ? { max_results: args.max_results } : {}),
            });

            return {
                content: [{ type: 'text', text: output }],
                isError,
            };
        }

        throw new JsonRpcToolError(-32601, `Unknown tool: ${toolName || '(none)'}`);
    },
});
