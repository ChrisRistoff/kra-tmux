import type { MCPLocalServerConfig, MCPRemoteServerConfig, MCPServerConfig } from "@/AI/AIAgent/shared/types/mcpConfig";

import { loadSettings } from "@/utils/common";
import { McpServerSettings } from "@/types/settingsTypes";

export function getGithubToken(): string | undefined {
    return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_API;
}

function isRemoteServer(server: McpServerSettings): server is Extract<McpServerSettings, { type: 'http' | 'sse' }> {
    return server.type === 'http' || server.type === 'sse';
}

function mapServerConfig(server: McpServerSettings): MCPServerConfig {
    if (isRemoteServer(server)) {
        const remoteConfig: MCPRemoteServerConfig = {
            type: server.type,
            url: server.url,
            tools: server.tools,
        };

        if (server.headers) {
            remoteConfig.headers = server.headers;
        }

        if (typeof server.timeoutMs === 'number') {
            remoteConfig.timeout = server.timeoutMs;
        }

        return remoteConfig;
    }

    const localConfig: MCPLocalServerConfig = {
        type: server.type,
        command: server.command,
        args: server.args,
        tools: server.tools,
    };

    if (server.env) {
        localConfig.env = server.env;
    }

    if (server.cwd) {
        localConfig.cwd = server.cwd;
    }

    if (typeof server.timeoutMs === 'number') {
        localConfig.timeout = server.timeoutMs;
    }

    return localConfig;
}

export async function getAgentDefaultModel(): Promise<string | undefined> {
    const settings = await loadSettings();

    return settings.ai?.agent?.defaultModel;
}

export async function getConfiguredMcpServers(): Promise<Record<string, MCPServerConfig>> {
    const settings = await loadSettings();
    const configuredServers = settings.ai?.agent?.mcpServers ?? {};

    return Object.entries(configuredServers).reduce<Record<string, MCPServerConfig>>((servers, [name, server]) => {
        if (!server.active) {
            return servers;
        }

        servers[name] = mapServerConfig(server);

        return servers;
    }, {});
}
