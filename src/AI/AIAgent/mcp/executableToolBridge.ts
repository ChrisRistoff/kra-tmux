import type { AgentSession } from '@/AI/AIAgent/shared/types/agentTypes';
import type { McpClientPool, RegisteredTool } from '@/AI/AIAgent/providers/byok/mcpClientPool';

export interface ExecutableToolBridgeOptions {
    uninitializedError?: string;
}

function listTools(pool: McpClientPool | undefined): RegisteredTool[] {
    return pool ? Array.from(pool.tools.values()) : [];
}

function findToolByTitle(pool: McpClientPool, title: string): RegisteredTool | undefined {
    return listTools(pool).find((tool) => `${tool.server}:${tool.originalName}` === title);
}

export function listExecutableToolsFromPool(
    pool: McpClientPool | undefined
): ReturnType<NonNullable<AgentSession['listExecutableTools']>> {
    return listTools(pool).map((tool) => ({
        title: `${tool.server}:${tool.originalName}`,
        server: tool.server,
        name: tool.originalName,
    }));
}

export async function executeToolFromPool(
    pool: McpClientPool | undefined,
    title: string,
    args: Record<string, unknown>,
    options: ExecutableToolBridgeOptions = {}
): Promise<string> {
    if (!pool) {
        throw new Error(options.uninitializedError ?? 'MCP pool not initialized');
    }

    const tool = findToolByTitle(pool, title);
    if (!tool) {
        throw new Error(`Unknown tool: ${title}`);
    }

    const result = await tool.client.callTool({ name: tool.originalName, arguments: args });
    const contentArray = (result.content ?? []) as Array<{ type: string; text?: string }>;

    return contentArray
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
}

export function createExecutableToolBridge(
    getPool: () => McpClientPool | undefined,
    options: ExecutableToolBridgeOptions = {}
): {
    listExecutableTools: NonNullable<AgentSession['listExecutableTools']>;
    executeTool: NonNullable<AgentSession['executeTool']>;
} {
    return {
        listExecutableTools: () => listExecutableToolsFromPool(getPool()),
        executeTool: async (title, args) => executeToolFromPool(getPool(), title, args, options),
    };
}

export async function disconnectPool(pool: McpClientPool | undefined, swallowErrors = false): Promise<void> {
    if (!pool) {
        return;
    }

    if (swallowErrors) {
        try {
            await pool.disconnect();
        } catch {
            return;
        }

        return;
    }

    await pool.disconnect();
}
