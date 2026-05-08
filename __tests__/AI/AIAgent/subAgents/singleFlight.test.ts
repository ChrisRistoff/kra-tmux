/**
 * Single-flight regression: only one investigation / execution may be running
 * at a time. Concurrent calls to the tool's `handler` must return the
 * rejection string immediately without spawning a second sub-agent.
 */
const mockRunSubAgentTask = jest.fn();

jest.mock('@/AI/AIAgent/shared/subAgents/session', () => ({
    runSubAgentTask: (...args: unknown[]) => mockRunSubAgentTask(...args),
}));

import { createExecuteTool } from '@/AI/AIAgent/shared/subAgents/executeTool';
import { createInvestigateTool } from '@/AI/AIAgent/shared/subAgents/investigateTool';
import type { AgentClient } from '@/AI/AIAgent/shared/types/agentTypes';
import type { ExecutorRuntime, InvestigatorRuntime } from '@/AI/AIAgent/shared/subAgents/types';

const fakeClient = {
    createSession: jest.fn(),
    stop: jest.fn(),
} as unknown as AgentClient;

const executorRuntime: ExecutorRuntime = {
    client: fakeClient,
    model: 'm',
    settings: {
        enabled: true,
        useInvestigatorRuntime: true,
        allowInterrupt: true,
        allowReplanEscape: true,
        includeDiffsInLog: true,
        maxToolCalls: 60,
        toolWhitelist: ['read_lines'],
    },
};

const investigatorRuntime: InvestigatorRuntime = {
    client: fakeClient,
    model: 'm',
    settings: {
        code: true,
        web: false,
        maxEvidenceItems: 8,
        maxExcerptLines: 20,
        validateExcerpts: false,
        toolWhitelist: ['search'],
    },
};

beforeEach(() => {
    mockRunSubAgentTask.mockReset();
});

describe('createExecuteTool single-flight', () => {
    it('rejects a second concurrent execute call', async () => {
        let resolveFirst!: (value: unknown) => void;
        mockRunSubAgentTask.mockImplementationOnce(
            async () => new Promise((resolve) => { resolveFirst = resolve; })
        );

        const tool = createExecuteTool({
            runtime: executorRuntime,
            mcpServers: {},
            workingDirectory: '/tmp/wd',
        });

        const first = tool.handler({ plan: 'do thing' });
        // Yield so handler hits the activeRun assignment.
        await new Promise((r) => setImmediate(r));
        const second = await tool.handler({ plan: 'do other thing' });

        expect(second).toMatch(/another execution is already running/);
        expect(mockRunSubAgentTask).toHaveBeenCalledTimes(1);

        resolveFirst({ result: { status: 'completed', summary: 's', events: [] }, events: [] });
        await first;
    });

    it('allows a new execute after the previous one completes', async () => {
        mockRunSubAgentTask
            .mockResolvedValueOnce({ result: { status: 'completed', summary: 'a', events: [] }, events: [] })
            .mockResolvedValueOnce({ result: { status: 'completed', summary: 'b', events: [] }, events: [] });

        const tool = createExecuteTool({
            runtime: executorRuntime,
            mcpServers: {},
            workingDirectory: '/tmp/wd',
        });

        const first = await tool.handler({ plan: 'p1' });
        const second = await tool.handler({ plan: 'p2' });

        expect(first).toContain('summary: a');
        expect(second).toContain('summary: b');
        expect(mockRunSubAgentTask).toHaveBeenCalledTimes(2);
    });

    it('reports a helpful message when the executor returns no captured result', async () => {
        mockRunSubAgentTask.mockResolvedValueOnce({
            result: undefined,
            events: [
                { kind: 'tool_start', toolName: 'read_lines' },
                { kind: 'tool_complete', success: true },
            ],
        });

        const tool = createExecuteTool({
            runtime: executorRuntime,
            mcpServers: {},
            workingDirectory: '/tmp/wd',
        });

        const out = await tool.handler({ plan: 'p' });

        expect(out).toMatch(/did not call submit_result/);
        expect(out).toContain('event count: 2');
    });
});

describe('createInvestigateTool single-flight', () => {
    it('rejects a second concurrent investigate call', async () => {
        let resolveFirst!: (value: unknown) => void;
        mockRunSubAgentTask.mockImplementationOnce(
            async () => new Promise((resolve) => { resolveFirst = resolve; })
        );

        const tool = createInvestigateTool({
            runtime: investigatorRuntime,
            mcpServers: {},
            workingDirectory: '/tmp/wd',
        });

        const first = tool.handler({ query: 'q1' });
        await new Promise((r) => setImmediate(r));
        const second = await tool.handler({ query: 'q2' });

        expect(second).toMatch(/another investigation is already running/i);
        expect(mockRunSubAgentTask).toHaveBeenCalledTimes(1);

        resolveFirst({
            result: { summary: 'done', evidence: [], confidence: 'low' },
            events: [],
        });
        await first;
    });
});
