import {
    createExecutableToolBridge,
    disconnectPool,
    executeToolFromPool,
    listExecutableToolsFromPool,
} from '@/AI/AIAgent/mcp/executableToolBridge';
import type { McpClientPool, RegisteredTool } from '@/AI/AIAgent/providers/byok/mcpClientPool';


function makeRegisteredTool(
    server: string,
    originalName: string,
    callTool?: unknown
): RegisteredTool {
    return {
        server,
        originalName,
        namespacedName: `${server}__${originalName}`,
        description: `${server}:${originalName}`,
        inputSchema: {},
        client: {
            callTool: (callTool ?? jest.fn(async () => ({ content: [] }))) as RegisteredTool['client']['callTool'],
        } as unknown as RegisteredTool['client'],
    };
}

function makePool(tools: RegisteredTool[]): McpClientPool {
    return {
        tools: new Map(tools.map((tool) => [`${tool.server}:${tool.originalName}`, tool])),
        openaiTools: [],
        disconnect: jest.fn(async () => undefined),
    };
}

describe('executableToolBridge', () => {
    it('lists tools in executable UI format', () => {
        const pool = makePool([makeRegisteredTool('kra-bash', 'bash')]);

        expect(listExecutableToolsFromPool(pool)).toEqual([
            { title: 'kra-bash:bash', server: 'kra-bash', name: 'bash' },
        ]);
    });

    it('executes the selected tool and joins text parts only', async () => {
        const callTool = jest.fn(async () => ({
            content: [
                { type: 'text', text: 'first line' },
                { type: 'image', data: 'ignored' },
                { type: 'text', text: 'second line' },
            ],
        }));
        const pool = makePool([makeRegisteredTool('kra-file', 'search', callTool)]);

        await expect(executeToolFromPool(pool, 'kra-file:search', { query: 'abc' })).resolves.toBe('first line\nsecond line');
        expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: { query: 'abc' } });
    });

    it('returns clear errors for unknown or unavailable tools', async () => {
        await expect(executeToolFromPool(undefined, 'kra-x:y', {}, { uninitializedError: 'Not ready' }))
            .rejects.toThrow('Not ready');

        const pool = makePool([]);

        await expect(executeToolFromPool(pool, 'kra-x:y', {})).rejects.toThrow('Unknown tool: kra-x:y');
    });

    it('bridge delegates listing/execution and disconnect helper supports swallow mode', async () => {
        const callTool = jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
        const pool = makePool([makeRegisteredTool('kra-memory', 'recall', callTool)]);

        const bridge = createExecutableToolBridge(() => pool);
        expect(bridge.listExecutableTools()).toEqual([
            { title: 'kra-memory:recall', server: 'kra-memory', name: 'recall' },
        ]);
        await expect(bridge.executeTool('kra-memory:recall', {})).resolves.toBe('ok');

        const throwingPool = {
            tools: new Map(),
            openaiTools: [],
            disconnect: jest.fn(async () => { throw new Error('disconnect failed'); }),
        } as unknown as McpClientPool;

        await expect(disconnectPool(throwingPool, true)).resolves.toBeUndefined();
        await expect(disconnectPool(throwingPool, false)).rejects.toThrow('disconnect failed');
    });
});