import type { AgentSessionOptions } from '@/AI/AIAgent/shared/types/agentTypes';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { McpClientPool, RegisteredTool } from '@/AI/AIAgent/providers/byok/mcpClientPool';

let originalSdkDisconnect = jest.fn(async () => undefined);
let currentSdkSession = {
    disconnect: originalSdkDisconnect,
};
const mockCopilotCreateSession = jest.fn(async () => currentSdkSession);

jest.mock('@github/copilot-sdk', () => ({
    CopilotClient: class {
        public createSession = mockCopilotCreateSession;
        public start = jest.fn(async () => undefined);
        public stop = jest.fn(async () => undefined);
        public forceStop = jest.fn(async () => undefined);
        public getAuthStatus = jest.fn(async () => ({}));
        public listModels = jest.fn(async () => []);
    },
}));

const mockBuildMcpClientPool = jest.fn();

jest.mock('@/AI/AIAgent/providers/byok/mcpClientPool', () => ({
    buildMcpClientPool: (...args: unknown[]) => mockBuildMcpClientPool(...args),
}));

import { OpenAICompatibleSession } from '@/AI/AIAgent/providers/byok/byokSession';
import { CopilotClientWrapper } from '@/AI/AIAgent/providers/copilot/copilotClient';

function typed<T>(value: unknown): T {
    return value as T;
}

function makeSessionOptions(): AgentSessionOptions {
    return {
        model: 'test-model',
        workingDirectory: '/tmp/workspace',
        mcpServers: {},
        onPreToolUse: async () => ({}),
        onPostToolUse: async () => undefined,
    };
}

function makePoolWithSingleTool(server: string, name: string, textResult: string): McpClientPool {
    const callTool = jest.fn(async () => ({ content: [{ type: 'text', text: textResult }] }));
    const tool: RegisteredTool = {
        server,
        originalName: name,
        namespacedName: `${server}__${name}`,
        description: `${server}:${name}`,
        inputSchema: {},
        client: typed<RegisteredTool['client']>({ callTool }),
    };

    return {
        tools: new Map([[`${server}:${name}`, tool]]),
        openaiTools: [],
        disconnect: jest.fn(async () => undefined),
    };
}

describe('provider executable tool bridge integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        originalSdkDisconnect = jest.fn(async () => undefined);
        currentSdkSession = {
            disconnect: originalSdkDisconnect,
        };
    });

    it('BYOK session exposes executable tools from MCP pool and executes by title', async () => {
        const session = new OpenAICompatibleSession({
            sessionOptions: makeSessionOptions(),
            apiKey: 'test-key',
            baseURL: 'https://example.test',
        });
        const pool = makePoolWithSingleTool('kra-bash', 'bash', 'pwd output');

        typed<{ mcp: McpClientPool | undefined }>(session).mcp = pool;

        expect(session.listExecutableTools()).toEqual([
            { title: 'kra-bash:bash', server: 'kra-bash', name: 'bash' },
        ]);
        await expect(session.executeTool('kra-bash:bash', { command: 'pwd' })).resolves.toBe('pwd output');

        await session.disconnect();
        expect(pool.disconnect).toHaveBeenCalledTimes(1);
    });

    it('Copilot wrapper wires kra-* side-pool tools for re-execution', async () => {
        const sidePool = makePoolWithSingleTool('kra-memory', 'recall', 'memory result');
        mockBuildMcpClientPool.mockResolvedValue(sidePool);

        const wrapper = new CopilotClientWrapper({ useLoggedInUser: true });
        const options: AgentSessionOptions = {
            ...makeSessionOptions(),
            mcpServers: {
                'kra-memory': typed<MCPServerConfig>({ type: 'stdio', command: 'node', args: ['memory.js'] }),
                'external-tool': typed<MCPServerConfig>({ type: 'stdio', command: 'node', args: ['ext.js'] }),
            },
        };

        const session = await wrapper.createSession(options);

        expect(mockBuildMcpClientPool).toHaveBeenCalledWith({
            servers: {
                'kra-memory': options.mcpServers['kra-memory'],
            },
            workingDirectory: '/tmp/workspace',
        });
        if (!session.listExecutableTools || !session.executeTool) {
            throw new Error('Copilot session should expose executable tool bridge methods');
        }

        expect(session.listExecutableTools()).toEqual([
            { title: 'kra-memory:recall', server: 'kra-memory', name: 'recall' },
        ]);
        await expect(session.executeTool('kra-memory:recall', { query: 'recent' })).resolves.toBe('memory result');

        await session.disconnect();
        expect(sidePool.disconnect).toHaveBeenCalledTimes(1);
        expect(originalSdkDisconnect).toHaveBeenCalledTimes(1);
    });
});
