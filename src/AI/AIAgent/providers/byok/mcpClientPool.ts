/**
 * MCP client pool for BYOK sessions.
 *
 * Spawns each configured local MCP server (via @modelcontextprotocol/sdk's
 * StdioClientTransport), lists its tools, and exposes a flat registry that
 * maps namespaced tool names ("<server>__<tool>") to:
 *   - the MCP client to invoke,
 *   - the original (un-namespaced) tool name,
 *   - the OpenAI-shaped function tool definition.
 *
 * Honors per-server `tools` allow-list and the session-level `excludedTools`
 * filter. Remote (http/sse) MCP servers are ignored — BYOK only deals with
 * local stdio servers (matches what the agent actually configures).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import { matchesSubAgentWhitelist } from '@/AI/AIAgent/shared/subAgents/whitelist';
import { getActiveSearchRepoKeys } from '@/AI/AIAgent/shared/memory/groups';

export interface RegisteredTool {
    server: string;
    originalName: string;
    namespacedName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    client: Client;
}

export interface McpClientPool {
    tools: Map<string, RegisteredTool>;
    openaiTools: Array<{
        type: 'function';
        function: { name: string; description: string; parameters: Record<string, unknown> };
    }>;
    disconnect: () => Promise<void>;
}

interface BuildPoolOptions {
    servers: Record<string, MCPServerConfig>;
    excludedTools?: string[];
    /**
     * Positive filter applied AFTER `excludedTools`. When set, only tools
     * whose namespaced name (`<server>__<tool>`) matches an entry — using
     * the same trailing-segment matcher as the sub-agent whitelist — are
     * registered. Used by sub-agent sessions to keep the model's tool
     * inventory tightly scoped.
     */
    allowedTools?: string[];
    workingDirectory: string;
}

function namespacedToolName(server: string, tool: string): string {
    const safeServer = server.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_');

    return `${safeServer}__${safeTool}`;
}

export async function buildMcpClientPool(options: BuildPoolOptions): Promise<McpClientPool> {
    const tools = new Map<string, RegisteredTool>();
    const clients: Client[] = [];
    const excluded = new Set(options.excludedTools ?? []);
    const allowedSet = options.allowedTools ? new Set(options.allowedTools) : null;

    // Resolve the active multi-repo search group once per pool build so each
    // spawned MCP server inherits the same set. Empty list ⇒ single-repo mode
    // (memoryMcpServer falls back to WORKING_DIR's repo on its own).
    const activeRepoKeys = await getActiveSearchRepoKeys();
    const searchRepoKeysEnv = activeRepoKeys.length > 0 ? activeRepoKeys.join(',') : '';

    for (const [serverName, config] of Object.entries(options.servers)) {
        if (config.type !== 'local' && config.type !== 'stdio') {
            continue;
        }

        const env: Record<string, string> = {
            ...Object.fromEntries(
                Object.entries(process.env).filter(([, value]) => value !== undefined) as [string, string][]
            ),
            ...(config.env ?? {}),
            WORKING_DIR: options.workingDirectory,
            ...(searchRepoKeysEnv ? { KRA_SEARCH_REPO_KEYS: searchRepoKeysEnv } : {}),
        };

        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env,
            ...(config.cwd ? { cwd: config.cwd } : {}),
        });

        const client = new Client(
            { name: 'kra-byok-agent', version: '1.0.0' },
            { capabilities: {} }
        );

        try {
            await client.connect(transport);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to connect MCP server '${serverName}': ${message}`);
        }

        clients.push(client);

        const allowList = config.tools ? new Set(config.tools) : null;
        const listed = await client.listTools();

        for (const tool of listed.tools) {
            if (allowList && !allowList.has(tool.name)) {
                continue;
            }

            if (excluded.has(tool.name)) {
                continue;
            }

            const namespaced = namespacedToolName(serverName, tool.name);

            if (allowedSet && !matchesSubAgentWhitelist(namespaced, allowedSet)) {
                continue;
            }

            tools.set(namespaced, {
                server: serverName,
                originalName: tool.name,
                namespacedName: namespaced,
                description: tool.description ?? '',
                inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
                    type: 'object',
                    properties: {},
                },
                client,
            });
        }
    }

    const openaiTools = Array.from(tools.values()).map((t) => ({
        type: 'function' as const,
        function: {
            name: t.namespacedName,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));

    return {
        tools,
        openaiTools,
        disconnect: async (): Promise<void> => {
            await Promise.allSettled(clients.map(async (c) => c.close()));
        },
    };
}
