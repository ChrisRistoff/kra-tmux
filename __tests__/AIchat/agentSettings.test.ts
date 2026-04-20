import { getAgentDefaultModel, getConfiguredMcpServers } from '@/AIchat/utils/agentSettings';
import { loadSettings } from '@/utils/common';

jest.mock('@/utils/common', () => ({
    loadSettings: jest.fn(),
}));

describe('agentSettings', () => {
    const mockedLoadSettings = jest.mocked(loadSettings);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns the configured default model', async () => {
        mockedLoadSettings.mockResolvedValue({
            watchCommands: {
                work: { active: false, watch: { windowName: '', command: '' } },
                personal: { active: false, watch: { windowName: '', command: '' } },
            },
            autosave: {
                active: true,
                currentSession: 'session',
                timeoutMs: 20000,
            },
            ai: {
                agent: {
                    defaultModel: 'gpt-5-mini',
                },
            },
        });

        await expect(getAgentDefaultModel()).resolves.toBe('gpt-5-mini');
    });

    it('maps only active MCP servers into SDK config', async () => {
        mockedLoadSettings.mockResolvedValue({
            watchCommands: {
                work: { active: false, watch: { windowName: '', command: '' } },
                personal: { active: false, watch: { windowName: '', command: '' } },
            },
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
