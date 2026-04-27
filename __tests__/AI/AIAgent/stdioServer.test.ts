import { EventEmitter } from 'events';
import readline from 'readline';
import { JsonRpcToolError, runStdioMcpServer } from '@/AI/AIAgent/mcp/stdioServer';

jest.mock('readline', () => ({
    __esModule: true,
    default: {
        createInterface: jest.fn(),
    },
}));

type FakeReadline = EventEmitter & {
    close: () => void;
};

function makeReadline(): FakeReadline {
    const rl = new EventEmitter() as FakeReadline;
    rl.close = (): void => {
        rl.emit('close');
    };

    return rl;
}

function parseResponses(writeSpy: jest.SpyInstance): Array<Record<string, unknown>> {
    return writeSpy.mock.calls
        .map((call) => String((call as unknown[])[0] ?? ''))
        .flatMap((chunk) => chunk.split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

describe('runStdioMcpServer', () => {
    let writeSpy: jest.SpyInstance;
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never);
    });

    afterEach(() => {
        writeSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('responds to initialize and tools/list with advertised server capabilities', async () => {
        const rl = makeReadline();
        jest.mocked(readline.createInterface).mockReturnValue(rl as unknown as readline.Interface);

        runStdioMcpServer({
            serverName: 'test-server',
            tools: [{ name: 'echo' }],
            handleToolCall: async () => ({ ok: true }),
        });

        rl.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
        rl.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
        await flushAsyncWork();

        const responses = parseResponses(writeSpy);
        const init = responses.find((response) => response['id'] === 1);
        const list = responses.find((response) => response['id'] === 2);

        expect(init?.['result']).toMatchObject({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-server' },
        });
        expect((list?.['result'] as { tools: Array<{ name: string }> }).tools).toEqual([{ name: 'echo' }]);
    });

    it('maps unknown tools and JsonRpcToolError to expected JSON-RPC errors', async () => {
        const rl = makeReadline();
        jest.mocked(readline.createInterface).mockReturnValue(rl as unknown as readline.Interface);

        runStdioMcpServer({
            serverName: 'test-server',
            tools: [{ name: 'echo' }],
            handleToolCall: async () => {
                throw new JsonRpcToolError(-32602, 'Invalid parameters');
            },
        });

        rl.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'missing' } }));
        rl.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo' } }));
        await flushAsyncWork();

        const responses = parseResponses(writeSpy);
        const unknownTool = responses.find((response) => response['id'] === 10);
        const invalidParams = responses.find((response) => response['id'] === 11);

        expect((unknownTool?.['error'] as { code: number }).code).toBe(-32601);
        expect((invalidParams?.['error'] as { code: number; message: string })).toEqual({
            code: -32602,
            message: 'Invalid parameters',
        });
    });

    it('honors parse-error mode and internal error result mapping', async () => {
        const rl = makeReadline();
        jest.mocked(readline.createInterface).mockReturnValue(rl as unknown as readline.Interface);

        runStdioMcpServer({
            serverName: 'test-server',
            tools: [{ name: 'echo' }],
            respondParseError: false,
            handleToolCall: async () => {
                throw new Error('handler boom');
            },
            onInternalError: () => ({ kind: 'result', result: { recovered: true } }),
        });

        rl.emit('line', '{not-json');
        rl.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'echo' } }));
        await flushAsyncWork();

        const responses = parseResponses(writeSpy);

        expect(responses.some((response) => (response['error'] as { code?: number } | undefined)?.code === -32700)).toBe(false);
        expect(responses.find((response) => response['id'] === 20)?.['result']).toEqual({ recovered: true });
    });

    it('exits when stdin closes after pending work is drained', async () => {
        const rl = makeReadline();
        jest.mocked(readline.createInterface).mockReturnValue(rl as unknown as readline.Interface);

        runStdioMcpServer({
            serverName: 'test-server',
            tools: [{ name: 'echo' }],
            handleToolCall: async () => ({ ok: true }),
        });

        rl.close();
        await flushAsyncWork();

        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
