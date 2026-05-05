/**
 * `execute` LocalTool — registered on the orchestrator session when the
 * executor sub-agent is enabled.
 *
 * The orchestrator hands a concrete plan to the executor (a smaller, cheaper
 * model) which carries it out using a wider toolset that includes write/edit
 * tools. The executor returns a typed event log + summary instead of streaming
 * the raw tool traffic back through the orchestrator's expensive context.
 *
 * Like `investigate`, every executor tool call flows through the orchestrator's
 * approval modal (tagged `[EXECUTOR]`), so the user retains full control.
 *
 * Phases not yet wired here (per plan.md):
 *   - Phase 4: real-time streaming controls (/orch, /exec) and Ctrl-C interrupt
 *     beyond the existing `stop_stream` abort.
 *   - Phase 5: `needs_replan` escape hatch — the result schema reserves a
 *     `'needs_replan'` status value but the orchestrator side doesn't yet
 *     react to it specially. For now it is surfaced as a regular tool result.
 */

import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';
import type { ExecutorRuntime } from '@/AI/AIAgent/shared/subAgents/types';
import { runSubAgentTask, type SubAgentChatBridge, type SubAgentEvent } from '@/AI/AIAgent/shared/subAgents/session';
import { buildExecutorTranscriptBlocks } from '@/AI/AIAgent/shared/subAgents/buildExecutorTranscript';
import type { TranscriptEntry } from '@/AI/AIAgent/shared/main/orchestratorTranscript';

export interface CreateExecuteToolOptions {
    runtime: ExecutorRuntime;
    mcpServers: Record<string, MCPServerConfig>;
    workingDirectory: string;
    chatBridge?: SubAgentChatBridge;
}

interface ExecuteArgs {
    plan: string;
    successCriteria?: string;
}

export interface ExecutionEvent {
    kind:
    | 'step_start'
    | 'step_done'
    | 'read'
    | 'edit'
    | 'create'
    | 'search'
    | 'run'
    | 'discovery'
    | 'decision'
    | 'blocked'
    | 'note';
    detail: string;
    path?: string;
    diff?: string;
}

export interface DecisionPoint {
    question: string;
    options?: string[];
}

export interface ExecutionResult {
    status: 'completed' | 'partial' | 'blocked' | 'needs_replan' | 'needs_decision';
    summary: string;
    events: ExecutionEvent[];
    blockers?: string[];
    replanReason?: string;
    decisionPoint?: DecisionPoint;
}

const EXECUTE_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        plan: {
            type: 'string',
            description: 'Concise directive plan: numbered steps naming files/symbols + intended outcomes. Do NOT restate findings or paste file contents — the executor receives a transcript of your prior investigations, reads, and reasoning automatically.',
        },
        successCriteria: {
            type: 'string',
            description: 'Optional explicit criteria for "done". Executor only marks `completed` if met; otherwise returns `partial`/`blocked`.',
        },
    },
    required: ['plan'],
    additionalProperties: false,
};

export function createExecuteTool(opts: CreateExecuteToolOptions): LocalTool {
    const { runtime, mcpServers, workingDirectory } = opts;
    const { settings } = runtime;

    let activeRun: Promise<string> | null = null;

    return {
        name: 'execute',
        serverLabel: 'kra-subagent',
        description: [
            'PREFERRED execution tool. Delegate concrete, multi-step work — multi-file edits,',
            'refactors, feature implementations — to a smaller, cheaper executor model.',
            'Returns ONLY a curated event log + summary; raw tool traffic stays out of your context.',
            '',
            'Plan: pass a terse, directive `plan` (numbered steps, named files/symbols). The executor',
            'is automatically given a transcript of your prior `investigate` calls, file reads, searches,',
            'and reasoning since the last execute — do NOT restate findings or paste contents in `plan`.',
            'Optional `successCriteria` gates `status: completed`.',
            '',
            'Possible result statuses: `completed`, `partial`, `blocked`, `needs_replan`,',
            'or `needs_decision` — when the executor hits a real design crossroad it bounces back',
            'to you with a `decisionPoint` (question + options) for you (and the user) to resolve.',
            '',
            'Skip `execute` only for one-line edits or work that needs orchestrator-grade reasoning',
            'at every step. Only ONE execution can run at a time.',
        ].join('\n'),
        parameters: EXECUTE_PARAMETERS,
        handler: async (rawArgs) => {
            if (activeRun) {
                return [
                    'execute: another execution is already running. Only one executor',
                    'is allowed at a time so the user retains full control. Wait for it',
                    'to finish and then issue your next execute call.',
                ].join(' ');
            }

            const args = rawArgs as unknown as ExecuteArgs;
            const transcriptSlice: TranscriptEntry[] = opts.chatBridge
                ? opts.chatBridge.getParentState().transcript.sliceSinceLastExecute()
                : [];
            const run = (async (): Promise<string> => {
                const systemPrompt = buildExecutorSystemPrompt(settings);
                const taskPrompt = buildExecutorTaskPrompt(args, transcriptSlice);

                const { result, events } = await runSubAgentTask({
                    runtime,
                    mcpServers,
                    workingDirectory,
                    systemPrompt,
                    taskPrompt,
                    toolWhitelist: settings.toolWhitelist,
                    resultSchema: buildResultSchema(),
                    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
                    ...(opts.chatBridge ? { chatBridge: opts.chatBridge } : {}),
                });

                if (!result) {
                    return [
                        'Executor did not call submit_result. It may have hit a tool-call',
                        'limit, refused the task, or been aborted by the user.',
                        `Captured event count: ${events.length}.`,
                        events.length > 0 ? `Last events: ${summariseRawEvents(events.slice(-5))}` : '',
                    ].filter(Boolean).join(' ');
                }

                const parsed = coerceResult(result);

                return formatExecutionResult(parsed);
            })();

            activeRun = run;

            try {
                return await run;
            } finally {
                activeRun = null;
            }
        },
    };
}

function buildExecutorSystemPrompt(settings: ExecutorRuntime['settings']): string {
    return [
        'You are an executor sub-agent. Carry out the concrete plan given by an orchestrator.',
        'You are NOT the planner — do not re-scope or ask for permission. You are a small fast',
        'model: bias toward the obvious answer; the orchestrator did the hard reasoning.',
        '',
        'Workflow:',
        '  1. Read <orchestrator_investigations> and <orchestrator_chat> FIRST — treat as',
        '     authoritative; do NOT re-read files the orchestrator already read.',
        '  2. Then read <plan> (WHAT to do) — the evidence blocks tell you WHERE.',
        '  3. Use the smallest tool sequence per step. Prefer narrow targeted reads.',
        '  4. Edits land in a proposal workspace (user reviews diff) — be precise but not timid.',
        '  5. Track meaningful actions as `events[]`; report them in your single `submit_result` call.',
        '  6. When done OR stuck, call `submit_result` exactly once with a `status`:',
        '       - `completed`      = every step done, success criteria met',
        '       - `partial`        = some done, others skipped (explain in summary)',
        '       - `blocked`        = a step cannot proceed (set `blockers`)',
        `       - \`needs_replan\`   = the plan itself is wrong${settings.allowReplanEscape
            ? ' (set `replanReason`)'
            : ' — DISABLED, do not use'}`,
        '       - `needs_decision` = you hit a real design crossroad (multiple reasonable',
        '         approaches, ambiguous requirement, unexpected scope question that the',
        '         orchestrator/user should answer). Set `decisionPoint.question` and, when',
        '         possible, `decisionPoint.options[]`. Do NOT guess at crossroads — bounce back.',
        '         Only use this for genuine decisions, not minor implementation choices you can pick.',
        '     Then briefly acknowledge and stop. Do NOT call any tool after `submit_result`,',
        '     and never call orchestrator-only end-of-turn tools — the orchestrator owns the turn.',
        `  7. Hard cap: ${settings.maxToolCalls} tool calls. If nearing the cap unfinished,`,
        '     submit `partial` with what was done in `events` and remaining work in `summary`.',
        '',
        'Quality bar: minimal surgical edits, no reformatting; each event `detail` is one sentence;',
        '`summary` is 2–6 sentences; mention any read-only file as a `read` event.',
    ].join('\n');
}

function buildExecutorTaskPrompt(args: ExecuteArgs, transcriptSlice: TranscriptEntry[]): string {
    const sections: string[] = [];

    if (transcriptSlice.length > 0) {
        sections.push(buildExecutorTranscriptBlocks(transcriptSlice));
    } else {
        sections.push('(No prior orchestrator activity in this turn — plan stands alone.)');
    }

    sections.push(['<plan>', args.plan, '</plan>'].join('\n'));

    if (args.successCriteria) {
        sections.push(['<success_criteria>', args.successCriteria, '</success_criteria>'].join('\n'));
    }

    return sections.join('\n\n');
}

function buildResultSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                enum: ['completed', 'partial', 'blocked', 'needs_replan', 'needs_decision'],
                description: 'Outcome of the execution. See system prompt for the meaning of each value.',
            },
            summary: {
                type: 'string',
                description: '2–6 sentences describing what was done, what changed, and any caveats.',
            },
            events: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        kind: {
                            type: 'string',
                            enum: [
                                'step_start', 'step_done', 'read', 'edit', 'create',
                                'search', 'run', 'discovery', 'decision', 'blocked', 'note',
                            ],
                        },
                        detail: {
                            type: 'string',
                            description: 'One-sentence human-readable description of the event.',
                        },
                        path: {
                            type: 'string',
                            description: 'Repository-relative file path, when the event refers to a file.',
                        },
                        diff: {
                            type: 'string',
                            description: 'Optional inline unified diff for edit/create events.',
                        },
                    },
                    required: ['kind', 'detail'],
                    additionalProperties: false,
                },
            },
            blockers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Required when status = blocked: list the things preventing completion.',
            },
            replanReason: {
                type: 'string',
                description: 'Required when status = needs_replan: why the plan itself is wrong.',
            },
            decisionPoint: {
                type: 'object',
                description: 'Required when status = needs_decision: a design crossroad needing the orchestrator\u2019s call.',
                properties: {
                    question: { type: 'string', description: 'The decision being faced, in one sentence.' },
                    options: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of the reasonable options you considered.',
                    },
                },
                required: ['question'],
                additionalProperties: false,
            },
        },
        required: ['status', 'summary', 'events'],
        additionalProperties: false,
    };
}

export function coerceResult(raw: Record<string, unknown>): ExecutionResult {
    const status = (
        raw['status'] === 'completed'
        || raw['status'] === 'partial'
        || raw['status'] === 'blocked'
        || raw['status'] === 'needs_replan'
        || raw['status'] === 'needs_decision'
    ) ? raw['status'] : 'partial';

    const summary = typeof raw['summary'] === 'string' ? raw['summary'] : '';

    const events: ExecutionEvent[] = Array.isArray(raw['events'])
        ? (raw['events'] as unknown[]).flatMap((e) => {
            if (typeof e !== 'object' || e === null) return [];
            const obj = e as Record<string, unknown>;
            const kind = typeof obj['kind'] === 'string' ? obj['kind'] : '';
            const detail = typeof obj['detail'] === 'string' ? obj['detail'] : '';

            if (!kind || !detail) return [];

            const ev: ExecutionEvent = { kind: kind as ExecutionEvent['kind'], detail };

            if (typeof obj['path'] === 'string') ev.path = obj['path'];
            if (typeof obj['diff'] === 'string') ev.diff = obj['diff'];

            return [ev];
        })
        : [];

    const result: ExecutionResult = { status, summary, events };

    if (Array.isArray(raw['blockers'])) {
        const blockers = (raw['blockers'] as unknown[]).filter((b): b is string => typeof b === 'string');

        if (blockers.length > 0) result.blockers = blockers;
    }

    if (typeof raw['replanReason'] === 'string') {
        result.replanReason = raw['replanReason'];
    }

    if (typeof raw['decisionPoint'] === 'object' && raw['decisionPoint'] !== null) {
        const dp = raw['decisionPoint'] as Record<string, unknown>;
        const question = typeof dp['question'] === 'string' ? dp['question'] : '';

        if (question) {
            const decision: DecisionPoint = { question };

            if (Array.isArray(dp['options'])) {
                const options = (dp['options'] as unknown[]).filter((o): o is string => typeof o === 'string');
                if (options.length > 0) decision.options = options;
            }

            result.decisionPoint = decision;
        }
    }

    return result;
}

export function formatExecutionResult(r: ExecutionResult): string {
    const lines: string[] = [
        `status: ${r.status}`,
        `summary: ${r.summary}`,
        '',
        `events (${r.events.length}):`,
    ];

    for (const ev of r.events) {
        const head = ev.path ? `${ev.kind} ${ev.path}` : ev.kind;
        lines.push(`  - [${head}] ${ev.detail}`);

        if (ev.diff) {
            const diffLines = ev.diff.split('\n').slice(0, 80).map((l) => `      ${l}`);
            lines.push(...diffLines);
        }
    }

    if (r.blockers && r.blockers.length > 0) {
        lines.push('', 'blockers:');

        for (const b of r.blockers) {
            lines.push(`  - ${b}`);
        }
    }

    if (r.replanReason) {
        lines.push('', `replanReason: ${r.replanReason}`);
    }

    if (r.decisionPoint) {
        lines.push('', `decisionPoint: ${r.decisionPoint.question}`);

        if (r.decisionPoint.options && r.decisionPoint.options.length > 0) {
            for (const opt of r.decisionPoint.options) {
                lines.push(`  - ${opt}`);
            }
        }
    }

    return lines.join('\n');
}

function summariseRawEvents(events: SubAgentEvent[]): string {
    return events
        .map((e) => {
            if (e.kind === 'tool_start' && e.toolName) return `tool_start:${e.toolName}`;
            if (e.kind === 'tool_complete') return `tool_complete:${e.success ? 'ok' : 'fail'}`;

            return e.kind;
        })
        .join(', ');
}
