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

export interface ExecutionResult {
    status: 'completed' | 'partial' | 'blocked' | 'needs_replan';
    summary: string;
    events: ExecutionEvent[];
    blockers?: string[];
    replanReason?: string;
}

const EXECUTE_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        plan: {
            type: 'string',
            description: [
                'A concise, directive plan for the executor to carry out: numbered',
                'steps in order, naming the files/symbols to touch and the intended',
                'outcome of each step. Keep it terse — do NOT restate findings,',
                'paste file contents, or summarise prior investigations here. The',
                'executor automatically receives a transcript of your prior',
                '`investigate` calls, file reads, searches, and reasoning since the',
                'last execute, so it already has the evidence; just tell it what',
                'to do.',
            ].join(' '),
        },
        successCriteria: {
            type: 'string',
            description: [
                'Optional explicit criteria for what counts as "done". The executor',
                'will only mark `status: completed` if these are met; otherwise it',
                'returns `partial` or `blocked` with a reason.',
            ].join(' '),
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
            'PREFERRED execution tool. Delegate any concrete, multi-step body of work',
            '— edits across several files, a refactor, a new feature implementation —',
            'to a smaller, cheaper executor model.',
            '',
            'Why use it:',
            '  - The executor runs the work end-to-end and returns ONLY a curated',
            '    event log + summary; the raw tool traffic (file reads, search results,',
            '    intermediate edits) never enters your context. That cuts the token',
            '    cost of tasks whose bulk is mechanical reads + edits rather than',
            '    reasoning.',
            '',
            'Workflow:',
            '  - Think the plan through (optionally call `investigate` first).',
            '  - Call `execute` with a terse, directive `plan` and (optionally)',
            '    `successCriteria`. The executor will only mark `status: completed`',
            '    if those criteria are met; otherwise it returns `partial` or',
            '    `blocked` with a reason.',
            '  - You do NOT need to copy findings or file contents into the plan —',
            '    the executor is automatically given a transcript of your prior',
            '    investigations, file reads, and reasoning since the last execute call.',
            '',
            'Skip `execute` only for one-line trivial edits or for tasks that genuinely',
            'need orchestrator-grade reasoning at every step.',
            '',
            'Only ONE execution can run at a time. Wait for the in-flight execution',
            'to return before issuing another.',
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
        'You are an executor sub-agent. Your job is to carry out a concrete plan',
        'handed to you by an orchestrator. You are NOT the planner — do not',
        're-scope the work, do not ask for permission, just execute.',
        '',
        'You are a small, fast model. Bias toward the obvious answer; do not',
        'over-think. The orchestrator has already done the hard reasoning.',
        '',
        'Workflow:',
        '  1. Read the two evidence blocks FIRST: <orchestrator_investigations>',
        '     (pre-digested findings from prior investigations) and',
        '     <orchestrator_chat> (the orchestrator\'s prior file reads, searches,',
        '     reasoning, and the user messages that led to this call). Treat both',
        '     as authoritative — do NOT re-read files the orchestrator already read.',
        '  2. Then read the <plan>. The plan tells you WHAT to do; the evidence',
        '     blocks tell you what is already known about WHERE.',
        '  3. For each step, use the smallest tool sequence that gets it done.',
        '     Prefer narrow, targeted reads over reading whole files.',
        '  4. When you make an edit, it lands in a proposal workspace — the user',
        '     will review the diff before it touches the real repo, so be precise',
        '     but do not be timid.',
        '  5. Track each meaningful action (edit, create, run) as you go; you will',
        '     report them all at once as `events[]` in your single `submit_result`',
        '     call at the end. Reads/searches that directly inform an edit can be',
        '     summarised in one `read` event.',
        '  6. When all steps are done OR you hit a blocker, call `submit_result`',
        '     exactly once with the appropriate `status`:',
        '       - `completed`   = every step done, success criteria met',
        '       - `partial`     = some steps done, others skipped (explain why)',
        '       - `blocked`     = a step cannot proceed (explain why in `blockers`)',
        `       - \`needs_replan\` = the plan itself is wrong${settings.allowReplanEscape
            ? ' (set `replanReason`)'
            : ' — DISABLED in settings, do not use'}`,
        '     Then output a brief acknowledgement and stop. Do NOT call any tool',
        '     after `submit_result`, and never call any orchestrator-only',
        '     end-of-turn tool — the orchestrator owns the turn.',
        `  7. Hard cap: ${settings.maxToolCalls} tool calls. If you are nearing the cap`,
        '     without finishing, submit with `status: partial`, list what was done',
        '     in `events`, and explain the remaining work in `summary`.',
        '',
        'Quality bar:',
        '  - Make MINIMAL, SURGICAL edits. Do not reformat untouched code.',
        '  - Every event\'s `detail` is a single human-readable sentence.',
        '  - Keep `summary` to 2–6 sentences.',
        '  - If you read a file you do not edit, mention it as a `read` event so',
        '    the orchestrator knows what informed your decisions.',
        '',
        'Example submit_result shape:',
        '  {',
        '    "status": "completed",',
        '    "summary": "Renamed `foo` to `bar` in 3 files; updated 1 test.",',
        '    "events": [',
        '      { "kind": "edit", "detail": "Renamed foo→bar.", "path": "src/x.ts" },',
        '      { "kind": "edit", "detail": "Updated import.", "path": "src/y.ts" },',
        '      { "kind": "edit", "detail": "Updated test name.", "path": "__tests__/x.test.ts" }',
        '    ]',
        '  }',
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
                enum: ['completed', 'partial', 'blocked', 'needs_replan'],
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
