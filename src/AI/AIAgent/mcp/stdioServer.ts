import readline from 'readline';

export type JsonRpcId = number | string | null;

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string };
}

export interface StdioMcpTool {
    name: string;
}

export interface RunStdioMcpServerOptions<TTool extends StdioMcpTool> {
    serverName: string;
    tools: readonly TTool[];
    handleToolCall: (input: { toolName: string; params: unknown; id: JsonRpcId }) => Promise<unknown>;
    allowPing?: boolean;
    respondParseError?: boolean;
    serverVersion?: string;
    onInternalError?: (error: unknown) => { kind: 'error'; code: number; message: string } | { kind: 'result'; result: unknown };
}

export class JsonRpcToolError extends Error {
    public readonly code: number;

    public constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

function send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
}

function sendResult(id: JsonRpcId, result: unknown): void {
    send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

export function runStdioMcpServer<TTool extends StdioMcpTool>(
    options: RunStdioMcpServerOptions<TTool>
): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const serverVersion = options.serverVersion ?? '1.0.0';
    const respondParseError = options.respondParseError ?? true;

    let pending = 0;
    let inputClosed = false;

    const hasTool = (toolName: string): boolean => options.tools.some((t) => t.name === toolName);

    function maybeExit(): void {
        if (inputClosed && pending === 0) {
            process.exit(0);
        }
    }

    rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let request: JsonRpcRequest;
        try {
            request = JSON.parse(trimmed) as JsonRpcRequest;
        } catch {
            if (respondParseError) sendError(null, -32700, 'Parse error');

            return;
        }

        const id = request.id ?? null;
        pending++;

        void (async (): Promise<void> => {
            try {
                switch (request.method) {
                    case 'initialize':
                        sendResult(id, {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: { name: options.serverName, version: serverVersion },
                        });

                        return;

                    case 'notifications/initialized':
                        return;

                    case 'tools/list':
                        sendResult(id, { tools: options.tools });

                        return;

                    case 'tools/call': {
                        const params = (request.params ?? {}) as { name?: unknown };
                        const toolName = typeof params.name === 'string' ? params.name : '';

                        if (!hasTool(toolName)) {
                            sendError(id, -32601, `Unknown tool: ${toolName || '(none)'}`);

                            return;
                        }

                        const result = await options.handleToolCall({ toolName, params: request.params ?? {}, id });
                        sendResult(id, result);

                        return;
                    }

                    case 'ping':
                        if (options.allowPing) {
                            sendResult(id, {});

                            return;
                        }
                        sendError(id, -32601, `Method not found: ${request.method}`);

                        return;

                    default:
                        sendError(id, -32601, `Method not found: ${request.method}`);

                        return;
                }
            } catch (error) {
                if (options.onInternalError) {
                    const mapped = options.onInternalError(error);
                    if (mapped.kind === 'error') {
                        sendError(id, mapped.code, mapped.message);
                    } else {
                        sendResult(id, mapped.result);
                    }

                    return;
                }

                if (error instanceof JsonRpcToolError) {
                    sendError(id, error.code, error.message);

                    return;
                }

                const message = error instanceof Error ? error.message : String(error);
                sendError(id, -32603, `Internal error: ${message}`);
            } finally {
                pending--;
                maybeExit();
            }
        })();
    });

    rl.on('close', () => {
        inputClosed = true;
        maybeExit();
    });
}
