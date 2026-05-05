import path from 'path';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import { getConfiguredMcpServers } from '@/AI/AIAgent/shared/utils/agentSettings';

function bundledServerScript(scriptName: string): string {
    return path.join(__dirname, '..', 'shared', 'utils', scriptName);
}

function stdioServer(scriptName: string, tools: string[]): MCPServerConfig {
    return {
        type: 'stdio',
        command: process.execPath,
        args: [bundledServerScript(scriptName)],
        tools,
    };
}

export async function buildCoreMcpServers(): Promise<Record<string, MCPServerConfig>> {
    const configuredServers = await getConfiguredMcpServers();

    return {
        ...configuredServers,
        'kra-session-complete': stdioServer('sessionCompleteMcpServer.js', ['confirm_task_complete']),
        'kra-file-context': stdioServer('fileContextMcpServer.js', [
            'get_outline',
            'read_lines',
            'read_function',
            'anchor_edit',
            'create_file',
            'search',
            'lsp_query',
        ]),
        'kra-memory': stdioServer('memoryMcpServer.js', [
            'remember',
            'recall',
            'update_memory',
            'edit_memory',
            'semantic_search',
            'docs_search',
        ]),
    };
}

export function buildByokExtraMcpServers(): Record<string, MCPServerConfig> {
    return {
        'kra-bash': stdioServer('bashMcpServer.js', ['bash']),
        'kra-web': stdioServer('webMcpServer.js', ['web_fetch', 'web_search']),
    };
}
