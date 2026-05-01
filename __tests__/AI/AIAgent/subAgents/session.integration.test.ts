import type {
    AgentClient,
    AgentSession,
    AgentSessionOptions,
    LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { runSubAgentTask } from '@/AI/AIAgent/shared/subAgents/session';

interface FakeSession extends AgentSession {
    handlers: Map<string, Array<(e: unknown) => void>>;
    submitTool: () => LocalTool | undefined;
    fireIdle: () => void;
    sentPrompts: string[];
    disconnectCalls: number;
}

function makeFakeClient(): { client: AgentClient; lastSession: () => FakeSession | undefined; lastOptions: () => AgentSessionOptions | undefined } {
    let last: FakeSession | undefined;
    let lastOpts: AgentSessionOptions | undefined;

    const client: AgentClient = {
        stop: jest.fn(async () => undefined),
        createSession: jest.fn(async (options: AgentSessionOptions) => {
            lastOpts = options;
            const handlers = new Map<string, Array<(e: unknown) => void>>();
            const session: Partial<FakeSession> = {
                handlers,
                sentPrompts: [],
                disconnectCalls: 0,
                on: ((event: string, handler: (e: unknown) => void) => {
                    if (!handlers.has(event)) handlers.set(event, []);
                    handlers.get(event)!.push(handler);
                }) as AgentSession['on'],
                send: jest.fn(async (opts: { prompt: string }) => {
                    (session as FakeSession).sentPrompts.push(opts.prompt);
                }),
                abort: jest.fn(async () => undefined),
                disconnect: jest.fn(async () => {
                    (session as FakeSession).disconnectCalls += 1;
                }),
                submitTool: () => options.localTools?.find((t) => t.name === 'submit_result'),
                fireIdle: () => {
                    for (const h of handlers.get('session.idle') ?? []) h({});
                },
            };
            last = session as FakeSession;

            return session as AgentSession;
        }),
    };

    return { client, lastSession: () => last, lastOptions: () => lastOpts };
}

describe('runSubAgentTask integration', () => {
    it('captures the structured result from submit_result and returns', async () => {
        const { client, lastSession, lastOptions } = makeFakeClient();
        const onEvent = jest.fn();

        const promise = runSubAgentTask({
            runtime: { client, model: 'test-model' },
            mcpServers: {},
            workingDirectory: '/tmp/wd',
            systemPrompt: 'sys',
            taskPrompt: 'task',
            toolWhitelist: ['read_lines'],
            resultSchema: { type: 'object' },
            onEvent,
        });

        // Let createSession + send resolve.
        await new Promise((r) => setImmediate(r));

        const session = lastSession()!;
        const submit = session.submitTool()!;

        expect(submit).toBeDefined();
        expect(submit.name).toBe('submit_result');

        // Simulate the model calling submit_result.
        const ack = await submit.handler({ status: 'completed', summary: 's', events: [] });

        expect(ack).toMatch(/Result accepted/);

        const { result, events } = await promise;

        expect(result).toEqual({ status: 'completed', summary: 's', events: [] });
        expect(events).toEqual([]);
        expect(session.disconnectCalls).toBe(1);
        expect(lastOptions()?.systemMessage).toEqual({ mode: 'replace', content: 'sys' });
        expect(session.sentPrompts).toEqual(['task']);
    });

    it('races submit_result against session.idle so a stuck model does not stall the orchestrator', async () => {
        const { client, lastSession } = makeFakeClient();

        const promise = runSubAgentTask({
            runtime: { client, model: 'test-model' },
            mcpServers: {},
            workingDirectory: '/tmp/wd',
            systemPrompt: 'sys',
            taskPrompt: 'task',
            toolWhitelist: [],
            resultSchema: { type: 'object' },
        });

        await new Promise((r) => setImmediate(r));

        const session = lastSession()!;

        // Submit the result, but DELIBERATELY never fire session.idle.
        await session.submitTool()!.handler({ status: 'completed', summary: 'done', events: [] });

        const settled = await Promise.race([
            promise.then(() => 'settled' as const),
            new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
        ]);

        expect(settled).toBe('settled');

        const { result } = await promise;
        expect(result).toEqual({ status: 'completed', summary: 'done', events: [] });
    });

    it('returns even when the model never submits, once session.idle fires', async () => {
        const { client, lastSession } = makeFakeClient();

        const promise = runSubAgentTask({
            runtime: { client, model: 'test-model' },
            mcpServers: {},
            workingDirectory: '/tmp/wd',
            systemPrompt: 'sys',
            taskPrompt: 'task',
            toolWhitelist: [],
            resultSchema: { type: 'object' },
        });

        await new Promise((r) => setImmediate(r));

        const session = lastSession()!;
        session.fireIdle();

        const { result, events } = await promise;
        expect(result).toBeUndefined();
        expect(events).toEqual([]);
        expect(session.disconnectCalls).toBe(1);
    });

    it('passes the tool whitelist as `allowedTools` to the SDK and allows submit_result through onPreToolUse', async () => {
        const { client, lastOptions, lastSession } = makeFakeClient();

        const promise = runSubAgentTask({
            runtime: { client, model: 'test-model' },
            mcpServers: {},
            workingDirectory: '/tmp/wd',
            systemPrompt: 'sys',
            taskPrompt: 'task',
            toolWhitelist: ['read_lines'],
            resultSchema: { type: 'object' },
        });

        await new Promise((r) => setImmediate(r));
        const opts = lastOptions()!;

        // The provider wrappers handle inventory filtering via `allowedTools`,
        // so the model never sees non-whitelisted tools. The runtime hook only
        // needs to short-circuit the synthetic `submit_result` tool and
        // delegate everything else to the bridge (or allow when no bridge).
        expect(opts.allowedTools).toEqual(expect.arrayContaining(['read_lines', 'submit_result']));

        const submit = await opts.onPreToolUse({
            toolName: 'submit_result',
            toolArgs: {},
        });
        expect(submit.permissionDecision).toBe('allow');

        const allowed = await opts.onPreToolUse({
            toolName: 'read_lines',
            toolArgs: {},
        });
        expect(allowed.permissionDecision).toBe('allow');

        // Submit and let it finish.
        await lastSession()!.submitTool()!.handler({ status: 'completed', summary: '', events: [] });
        await promise;
    });

    it('forwards assistant message deltas and tool events to onEvent', async () => {
        const { client, lastSession } = makeFakeClient();
        const onEvent = jest.fn();

        const promise = runSubAgentTask({
            runtime: { client, model: 'test-model' },
            mcpServers: {},
            workingDirectory: '/tmp/wd',
            systemPrompt: 'sys',
            taskPrompt: 'task',
            toolWhitelist: ['read_lines'],
            resultSchema: { type: 'object' },
            onEvent,
        });

        await new Promise((r) => setImmediate(r));

        const session = lastSession()!;

        // Drive synthetic events into the session handlers.
        session.handlers.get('assistant.message_delta')?.[0]?.({ data: { deltaContent: 'hello' } });
        session.handlers.get('tool.execution_start')?.[0]?.({ data: { toolName: 'read_lines' } });
        session.handlers.get('tool.execution_complete')?.[0]?.({ data: { success: true } });

        await session.submitTool()!.handler({ status: 'completed', summary: '', events: [] });
        const { events } = await promise;

        expect(events).toEqual([
            { kind: 'message', text: 'hello' },
            { kind: 'tool_start', toolName: 'read_lines' },
            { kind: 'tool_complete', success: true },
        ]);
        expect(onEvent).toHaveBeenCalledTimes(3);
    });

    it('passes contextWindow through to createSession only when provided', async () => {
        const { client, lastOptions, lastSession } = makeFakeClient();

        const p1 = runSubAgentTask({
            runtime: { client, model: 'm', contextWindow: 100_000 },
            mcpServers: {},
            workingDirectory: '/tmp',
            systemPrompt: 's',
            taskPrompt: 't',
            toolWhitelist: [],
            resultSchema: { type: 'object' },
            contextWindow: 100_000,
        });
        await new Promise((r) => setImmediate(r));
        expect(lastOptions()?.contextWindow).toBe(100_000);
        await lastSession()!.submitTool()!.handler({ status: 'completed', summary: '', events: [] });
        await p1;

        const p2 = runSubAgentTask({
            runtime: { client, model: 'm' },
            mcpServers: {},
            workingDirectory: '/tmp',
            systemPrompt: 's',
            taskPrompt: 't',
            toolWhitelist: [],
            resultSchema: { type: 'object' },
        });
        await new Promise((r) => setImmediate(r));
        expect(lastOptions()?.contextWindow).toBeUndefined();
        await lastSession()!.submitTool()!.handler({ status: 'completed', summary: '', events: [] });
        await p2;
    });
});
