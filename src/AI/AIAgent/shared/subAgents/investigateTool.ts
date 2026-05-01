/**
 * `investigate` LocalTool — registered on the orchestrator session when the
 * investigator sub-agent is enabled.
 *
 * The orchestrator delegates research work to a smaller, cheaper model that
 * runs with read-only / discovery tools and returns a typed evidence-backed
 * synthesis. Each `evidence` excerpt is validated against the actual file
 * before being handed back, so hallucinated snippets don't reach the planner.
 *
 * The tool flows through the standard pre/post-tool hooks, so the user can
 * approve, deny, or edit the investigator's `query` / `hint` / `scope` /
 * `kind` arguments before the sub-agent runs.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';
import type { InvestigatorRuntime } from '@/AI/AIAgent/shared/subAgents/types';
import { runSubAgentTask, type SubAgentChatBridge } from '@/AI/AIAgent/shared/subAgents/session';

export interface CreateInvestigateToolOptions {
    runtime: InvestigatorRuntime;
    mcpServers: Record<string, MCPServerConfig>;
    workingDirectory: string;
    /**
     * Optional bridge into the orchestrator's chat / approval modal. When set,
     * every investigator tool call goes through the same approval flow as
     * orchestrator tool calls (tagged `[INVESTIGATOR]`), and assistant
     * text/reasoning/tool events stream into the same chat file.
     */
    chatBridge?: SubAgentChatBridge;
}

interface EvidenceItem {
    path: string;
    lines: string;
    excerpt: string;
    why_relevant: string;
}

interface InvestigationResult {
    summary: string;
    evidence: EvidenceItem[];
    confidence: 'high' | 'medium' | 'low';
    suggested_next?: string;
}

interface InvestigateArgs {
    query: string;
    hint?: string;
    scope?: string;
    kind?: 'find_implementation' | 'find_usages' | 'find_pattern' | 'explain_flow' | 'general';
}

const INVESTIGATE_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: 'The research question. Be concrete: what do you need to know?',
        },
        hint: {
            type: 'string',
            description:
                'Optional steering hint: pass ANYTHING that could help the investigator — known file paths, symbol names, partial findings from earlier in the conversation, prior assistant context, user constraints, suspected cause, links to related code, or anything else you have learned that the investigator would not see on its own. The investigator only sees what you put in `query` + `hint`, so be generous.',
        },
        scope: {
            type: 'string',
            description: 'Optional path glob to restrict the search (e.g. "src/AI/**").',
        },
        kind: {
            type: 'string',
            enum: ['find_implementation', 'find_usages', 'find_pattern', 'explain_flow', 'general'],
            description: 'Optional category hint to bias the investigator toward the right tool mix.',
        },
    },
    required: ['query'],
    additionalProperties: false,
};

export function createInvestigateTool(opts: CreateInvestigateToolOptions): LocalTool {
    const { runtime, mcpServers, workingDirectory } = opts;
    const { settings } = runtime;

    let activeRun: Promise<string> | null = null;

    return {
        name: 'investigate',
        serverLabel: 'kra-subagent',
        description: [
            'PREFERRED first-step research tool. Whenever the answer to a user question requires',
            'reading more than ~2 files, searching the codebase, or tracing a flow across modules,',
            'call `investigate` BEFORE doing any reads/searches yourself. The investigator runs on a',
            'cheaper model and returns a curated, evidence-backed synthesis (verified excerpts +',
            'short summary) instead of raw file dumps — it saves your context and your tokens.',
            'You may call `investigate` at ANY point in the turn — not just at the start. If a',
            'follow-up question or partial result reveals you need more research, dispatch another',
            'investigation then. When you do, pass anything that might help via `hint`: known paths,',
            'symbol names, prior findings, user context, suspected cause — the investigator only sees',
            'what you give it, so include any context that would shortcut its work.',
            'Skip it only for trivial lookups where you already know the exact file + line range, or',
            'when you must edit immediately based on context the user just gave you.',
            'A single `query` may bundle tightly-related sub-questions that share the same scope',
            '(e.g. "how does X work and where is it tested?"). Do NOT combine unrelated topics in',
            'one call — it dilutes the evidence and burns the investigator\'s smaller context budget.',
            'Only ONE investigation can run at a time — if a previous call is still in flight,',
            'this tool will reject the new request. Wait for the running investigation to finish',
            'before issuing another.',
        ].join(' '),
        parameters: INVESTIGATE_PARAMETERS,
        handler: async (rawArgs) => {
            if (activeRun) {
                return [
                    'investigate: another investigation is already running. Only one investigator',
                    'is allowed at a time so the user retains full control. Wait for it to finish',
                    'and then issue your next investigate call.',
                ].join(' ');
            }

            const args = rawArgs as unknown as InvestigateArgs;
            const run = (async (): Promise<string> => {
                const systemPrompt = buildInvestigatorSystemPrompt(settings);
                const taskPrompt = buildInvestigatorTaskPrompt(args);

                const { result, events } = await runSubAgentTask({
                    runtime,
                    mcpServers,
                    workingDirectory,
                    systemPrompt,
                    taskPrompt,
                    toolWhitelist: settings.toolWhitelist,
                    resultSchema: buildResultSchema(settings.maxEvidenceItems),
                    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
                    ...(opts.chatBridge ? { chatBridge: opts.chatBridge } : {}),
                });

                if (!result) {
                    return [
                        'Investigator did not call submit_result. Possible reasons: hit a tool-call limit,',
                        'or refused the task. Captured event count: ' + String(events.length) + '.',
                    ].join(' ');
                }

                const parsed = coerceResult(result);

                if (settings.validateExcerpts) {
                    parsed.evidence = await validateEvidence(parsed.evidence, workingDirectory);
                }

                if (parsed.evidence.length > settings.maxEvidenceItems) {
                    parsed.evidence = parsed.evidence.slice(0, settings.maxEvidenceItems);
                }

                return JSON.stringify(parsed, null, 2);
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

function buildInvestigatorSystemPrompt(settings: InvestigatorRuntime['settings']): string {
    return [
        'You are an investigator sub-agent. Your job is to answer a single research question',
        'with concrete, evidence-backed findings — NOT to make code changes.',
        '',
        'Workflow:',
        '  1. Use semantic_search / search / get_outline / lsp_query / docs_search / recall to',
        '     locate the most relevant code or docs.',
        '  2. Use read_lines to capture short, exact excerpts that justify your conclusions.',
        `  3. Cap excerpts at ${settings.maxExcerptLines} lines. Cap total evidence items at ${settings.maxEvidenceItems}.`,
        '  4. When you have enough, call `submit_result` with a structured summary + evidence.',
        '  5. Do NOT call any tool after submit_result. Output a brief acknowledgement and stop.',
        '  6. NEVER call `confirm_task_complete` or any other end-of-turn tool. The orchestrator',
        '     owns the turn. Your only "end" is `submit_result`; control then returns to the',
        '     orchestrator automatically.',
        '',
        'Quality bar:',
        '  - Every excerpt MUST be copied verbatim from the file at the stated line range.',
        '  - Set `confidence` honestly. If you could not find what was asked, say so.',
        '  - Prefer fewer, high-signal excerpts over many shallow ones.',
        '',
        `Allowed tools: ${settings.toolWhitelist.join(', ')}, submit_result.`,
        'Any other tool call will be denied.',
    ].join('\n');
}

function buildInvestigatorTaskPrompt(args: InvestigateArgs): string {
    const lines = [`Research question: ${args.query}`];

    if (args.kind) {
        lines.push(`Category: ${args.kind}`);
    }

    if (args.scope) {
        lines.push(`Scope (path glob): ${args.scope}`);
    }

    if (args.hint) {
        lines.push(`Hint from caller: ${args.hint}`);
    }

    lines.push('', 'Investigate, then call submit_result with your structured findings.');

    return lines.join('\n');
}

function buildResultSchema(maxEvidenceItems: number): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A 2–6 sentence answer to the research question, citing the evidence.',
            },
            evidence: {
                type: 'array',
                maxItems: maxEvidenceItems,
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Repository-relative file path.' },
                        lines: {
                            type: 'string',
                            description: 'Line range, e.g. "120-145" or "47-47" for a single line.',
                        },
                        excerpt: {
                            type: 'string',
                            description: 'Verbatim excerpt copied from the file at the stated line range.',
                        },
                        why_relevant: {
                            type: 'string',
                            description: '1–2 sentences explaining why this snippet matters.',
                        },
                    },
                    required: ['path', 'lines', 'excerpt', 'why_relevant'],
                    additionalProperties: false,
                },
            },
            confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
            },
            suggested_next: {
                type: 'string',
                description: 'Optional: what the orchestrator should do or look at next.',
            },
        },
        required: ['summary', 'evidence', 'confidence'],
        additionalProperties: false,
    };
}

function coerceResult(raw: Record<string, unknown>): InvestigationResult {
    const summary = typeof raw['summary'] === 'string' ? raw['summary'] : '';
    const confidence =
        raw['confidence'] === 'high' || raw['confidence'] === 'medium' || raw['confidence'] === 'low'
            ? raw['confidence']
            : 'low';
    const evidence = Array.isArray(raw['evidence'])
        ? (raw['evidence'] as unknown[]).flatMap((e) => {
            if (typeof e !== 'object' || e === null) {
                return [];
            }
            const obj = e as Record<string, unknown>;
            const filePath = typeof obj['path'] === 'string' ? obj['path'] : '';
            const lines = typeof obj['lines'] === 'string' ? obj['lines'] : '';
            const excerpt = typeof obj['excerpt'] === 'string' ? obj['excerpt'] : '';
            const whyRelevant = typeof obj['why_relevant'] === 'string' ? obj['why_relevant'] : '';

            if (!filePath || !lines || !excerpt) {
                return [];
            }

            return [{ path: filePath, lines, excerpt, why_relevant: whyRelevant }];
        })
        : [];

    const result: InvestigationResult = { summary, evidence, confidence };

    if (typeof raw['suggested_next'] === 'string') {
        result.suggested_next = raw['suggested_next'];
    }

    return result;
}

interface ParsedRange {
    start: number;
    end: number;
}

function parseRange(s: string): ParsedRange | undefined {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s);

    if (!match) {
        return undefined;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        return undefined;
    }

    return { start, end };
}

function normaliseForCompare(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

async function validateEvidence(
    evidence: EvidenceItem[],
    workingDirectory: string
): Promise<EvidenceItem[]> {
    const validated: EvidenceItem[] = [];

    for (const item of evidence) {
        const range = parseRange(item.lines);

        if (!range) {
            validated.push({ ...item, why_relevant: `[unverified: bad line range] ${item.why_relevant}` });
            continue;
        }

        const fullPath = path.isAbsolute(item.path)
            ? item.path
            : path.join(workingDirectory, item.path);

        let fileContent: string;

        try {
            fileContent = await fs.readFile(fullPath, 'utf8');
        } catch {
            validated.push({ ...item, why_relevant: `[unverified: file not found] ${item.why_relevant}` });
            continue;
        }

        const fileLines = fileContent.split('\n');
        const sliceStart = Math.max(0, range.start - 1);
        const sliceEnd = Math.min(fileLines.length, range.end);
        const actualSlice = fileLines.slice(sliceStart, sliceEnd).join('\n');

        const a = normaliseForCompare(actualSlice);
        const b = normaliseForCompare(item.excerpt);

        if (a.includes(b) || b.includes(a)) {
            validated.push(item);
        } else {
            validated.push({
                ...item,
                why_relevant: `[unverified: excerpt does not match file at ${item.lines}] ${item.why_relevant}`,
            });
        }
    }

    return validated;
}
