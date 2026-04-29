import { getConfiguredMcpServers } from '@/AI/AIAgent/shared/utils/agentSettings';
import { loadSettings } from '@/utils/common';

jest.mock('@/utils/common', () => ({
    loadSettings: jest.fn(),
}));

describe('agentSettings', () => {
    const mockedLoadSettings = jest.mocked(loadSettings);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('maps only active MCP servers into SDK config', async () => {
        mockedLoadSettings.mockResolvedValue({
            autosave: {
                active: true,
                currentSession: 'session',
                timeoutMs: 20000,
            },
            ai: {
                agent: {
                    mcpServers: {
                        filesystem: {
                            active: true,
                            type: 'local',
                            command: 'npx',
                            args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
                            tools: ['*'],
                            timeoutMs: 15000,
                        },
                        github: {
                            active: false,
                            type: 'http',
                            url: 'https://example.com/mcp',
                            headers: { Authorization: 'Bearer token' },
                            tools: ['*'],
                        },
                    },
                },
            },
        });

        await expect(getConfiguredMcpServers()).resolves.toEqual({
            filesystem: {
                type: 'local',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
                tools: ['*'],
                timeout: 15000,
            },
        });
    });
});
