/**
 * Local MCP server config — replaces `MCPServerConfig` from `@github/copilot-sdk`
 * so `shared/` has no SDK dependency. Mirrors the SDK shape.
 */

export interface MCPLocalServerConfig {
    type: 'local' | 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
    tools?: string[];
}

export interface MCPRemoteServerConfig {
    type: 'http' | 'sse';
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    tools?: string[];
}

export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;
