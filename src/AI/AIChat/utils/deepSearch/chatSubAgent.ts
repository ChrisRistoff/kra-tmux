/**
 * Inline `deep_search` runner for the AI Chat.
 *
 * Spawns a fresh OpenAI client (same provider+model as the outer chat) and
 * runs a budgeted tool-call loop with 3 web research tools + a synthetic
 * `submit_result` terminator. Returns ONE curated digest to the caller — the
 * outer chat never sees raw search results, raw page contents, or the inner
 * loop's intermediate text. Conceptually mirrors the agent's
 * `investigate_web` sub-agent, but built natively for the chat's
 * OpenAI-completions runtime so we don't have to drag in `AgentSession`.
 *
 * Cost: each `deep_search({query})` invocation triggers up to
 * `maxToolCalls` model calls (one per turn of the inner loop), plus the
 * model's response after each tool call. Quotas in `DeepSearchSettings`
 * bound the worst case.
 */

import { randomUUID } from 'crypto';
import OpenAI from 'openai';

import { requestChatToolApproval } from '@/AI/AIChat/utils/chatToolApproval';
import type {
    ChatCompletionFunctionTool,
    ChatCompletionMessageParam,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionAssistantMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionChunk,
} from 'openai/resources/chat/completions/completions';

import { getProviderApiKey, getProviderBaseURL } from '@/AI/shared/data/providers';
import { createWebResearchTools } from '@/AI/AIAgent/shared/subAgents/webResearchTools';
import type { LocalTool } from '@/AI/AIAgent/shared/types/agentTypes';

import { buildDeepSearchSystemPrompt } from './prompt';
import type { DeepSearchSettings } from './settings';

export interface DeepSearchEvidenceItem {
    url: string;
    section?: string;
    excerpt: string;
}

export interface DeepSearchResult {
    summary: string;
    evidence: DeepSearchEvidenceItem[];
    confidence?: 'low' | 'medium' | 'high';
    partial?: boolean;
    reason?: string;
    stats: {
        toolCalls: number;
        searches: number;
        scrapes: number;
        pagesFetched: number;
        pagesFailed: number;
        chunksIndexed: number;
    };
}

export interface RunDeepSearchOptions {
    query: string;
    hint?: string;
    provider: string;
    model: string;
    settings: DeepSearchSettings;
    repoKey?: string;
    /** Optional injected client for tests. */
    openai?: OpenAI;
    signal?: AbortSignal;
    /**
     * Optional progress sink. Called with short status lines (e.g.
     * `"→ web_search(\"foo\")"`, `"← web_search returned 4823 chars"`,
     * `"submitting result"`). The chat-side bridge writes these to the
     * transcript so the user can see what the inner loop is doing.
     */
    onProgress?: (msg: string) => void | Promise<void>;
    /**
     * Optional Neovim client + approval state. When both are provided,
     * each inner-loop tool call (web_search/web_scrape_and_index/
     * research_query) is gated through the same approval popup the
     * outer chat uses. Decisions persist via the shared state so
     * `allow-family` carries across the inner loop and back to the
     * outer chat.
     */
    nvim?: import('neovim').NeovimClient;
    approval?: import('@/AI/AIChat/utils/chatToolApproval').ChatApprovalState;
}

const SUBMIT_RESULT_NAME = 'submit_result';

function localToolToOpenAi(tool: LocalTool): ChatCompletionFunctionTool {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    };
}

function buildSubmitResultTool(maxEvidence: number): ChatCompletionFunctionTool {
    return {
        type: 'function',
        function: {
            name: SUBMIT_RESULT_NAME,
            description:
                'Finalize the research and return the result to the chat. '
                + 'This is the ONLY way to terminate. Plain text replies are ignored.',
            parameters: {
                type: 'object',
                properties: {
                    summary: {
                        type: 'string',
                        description: 'Concise prose answer to the user\'s question. May reference evidence.',
                    },
                    evidence: {
                        type: 'array',
                        description: `Up to ${maxEvidence} evidence items supporting the summary. Each item must cite a real URL.`,
                        items: {
                            type: 'object',
                            properties: {
                                url: { type: 'string' },
                                section: { type: 'string' },
                                excerpt: {
                                    type: 'string',
                                    description: 'Verbatim excerpt from the indexed page (no paraphrasing).',
                                },
                            },
                            required: ['url', 'excerpt'],
                            additionalProperties: false,
                        },
                    },
                    confidence: {
                        type: 'string',
                        enum: ['low', 'medium', 'high'],
                        description: 'How confident you are in the summary.',
                    },
                    partial: {
                        type: 'boolean',
                        description: 'Set true if you ran out of budget before fully answering.',
                    },
                    reason: {
                        type: 'string',
                        description: 'Optional brief note for the caller (e.g. why partial).',
                    },
                },
                required: ['summary', 'evidence'],
                additionalProperties: false,
            },
        },
    };
}

interface SubmitResultPayload {
    summary?: unknown;
    evidence?: unknown;
    confidence?: unknown;
    partial?: unknown;
    reason?: unknown;
}

function coerceEvidence(raw: unknown, maxItems: number, maxLines: number): DeepSearchEvidenceItem[] {
    if (!Array.isArray(raw)) return [];
    const out: DeepSearchEvidenceItem[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as { url?: unknown; section?: unknown; excerpt?: unknown };
        if (typeof obj.url !== 'string' || typeof obj.excerpt !== 'string') continue;
        const trimmedExcerpt = obj.excerpt.split(/\r?\n/).slice(0, maxLines).join('\n');
        const entry: DeepSearchEvidenceItem = {
            url: obj.url,
            excerpt: trimmedExcerpt,
        };
        if (typeof obj.section === 'string') entry.section = obj.section;
        out.push(entry);
        if (out.length >= maxItems) break;
    }

    return out;
}

/**
 * Format a provider/SDK error into a multi-line diagnostic string. Includes
 * HTTP status, error code/type, and any nested response body so the chat
 * surface can show the *actual* upstream failure instead of just "500 Failed
 * to generate response".
 */
function describeProviderError(err: unknown, provider: string, model: string, phase: string): string {
    const e = err as {
        status?: number;
        code?: string;
        type?: string;
        message?: string;
        error?: unknown;
        response?: { status?: number; data?: unknown };
    } | undefined;
    const status = e?.status ?? e?.response?.status;
    const code = e?.code;
    const type = e?.type;
    const message = e?.message ?? (err instanceof Error ? err.message : String(err));
    const body = e?.error ?? e?.response?.data;
    const parts = [
        `provider=${provider}`,
        `model=${model}`,
        `phase=${phase}`,
        status !== undefined ? `status=${status}` : null,
        code ? `code=${code}` : null,
        type ? `type=${type}` : null,
        `message=${message}`,
    ].filter(Boolean);
    let out = parts.join(' | ');

    if (body !== undefined) {
        let bodyStr: string;
        try {
            bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        } catch {
            bodyStr = String(body);
        }
        if (bodyStr.length > 1000) bodyStr = bodyStr.slice(0, 1000) + '…';
        out += `\nbody: ${bodyStr}`;
    }

    return out;
}

/**
 * Consume a streaming chat-completion response and accumulate the deltas
 * into the same `{content, toolCalls}` shape we used to read off the
 * non-streaming `choices[0].message`. Tool-call deltas are merged by `index`.
 *
 * Why streaming: several providers (notably crof's deepseek-v4-flash) have a
 * server-side timeout on non-streaming requests that surfaces as a generic
 * 500 once the model takes "a while" to respond — typically after a few tool
 * rounds. Streaming keeps the connection alive chunk-by-chunk and matches
 * what the agent's session does.
 */
async function accumulateStream(
    stream: AsyncIterable<ChatCompletionChunk>,
): Promise<{ content: string; toolCalls: ChatCompletionMessageFunctionToolCall[] }> {
    let content = '';
    const partial = new Map<number, { id?: string; name?: string; arguments: string }>();

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') content += delta.content;
        const tcDeltas = delta.tool_calls;
        if (Array.isArray(tcDeltas)) {
            for (const tc of tcDeltas) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const slot = partial.get(idx) ?? { arguments: '' };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments;
                partial.set(idx, slot);
            }
        }
    }

    const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const idx of [...partial.keys()].sort((a, b) => a - b)) {
        const slot = partial.get(idx)!;
        if (!slot.name) continue;
        toolCalls.push({
            id: slot.id ?? `call_${idx}`,
            type: 'function',
            function: { name: slot.name, arguments: slot.arguments },
        });
    }

    return { content, toolCalls };
}

function makeOpenAiClient(provider: string): OpenAI {
    const apiKey = getProviderApiKey(provider);
    const baseURL = getProviderBaseURL(provider);

    return new OpenAI({ apiKey, baseURL });
}

/**
 * One-line summary of tool args for the chat progress feed. Keeps URLs short,
 * truncates queries, never dumps page bodies.
 */
function summarizeToolArgs(args: Record<string, unknown>): string {
    const parts: string[] = [];
    if (typeof args.query === 'string') {
        const q = args.query.length > 60 ? args.query.slice(0, 57) + '…' : args.query;
        parts.push(`query=${JSON.stringify(q)}`);
    }
    if (Array.isArray(args.queries)) {
        parts.push(`queries=[${args.queries.length}]`);
    }
    if (Array.isArray(args.urls)) {
        const first = typeof args.urls[0] === 'string' ? args.urls[0] : '';
        const tail = args.urls.length > 1 ? ` +${args.urls.length - 1}` : '';
        parts.push(`urls=${first}${tail}`);
    }
    if (typeof args.k === 'number') parts.push(`k=${args.k}`);
    if (typeof args.max_results === 'number') parts.push(`max_results=${args.max_results}`);

    return parts.join(', ');
}

/**
 * Map a JSON-arguments string from the model into a parsed object the
 * `LocalTool` handlers expect. Returns null if the args are unparseable.
 */
/**
 * Map a JSON-arguments string from the model into a parsed object the
 * `LocalTool` handlers expect. Returns null if the args are unparseable.
 */
function parseToolArgs(raw: string): Record<string, unknown> | null {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }

        return null;
    } catch {
        return null;
    }
}

export async function runDeepSearch(options: RunDeepSearchOptions): Promise<DeepSearchResult> {
    const { query, hint, provider, model, settings, repoKey, signal, onProgress, nvim, approval } = options;

    const emitProgress = async (msg: string): Promise<void> => {
        if (!onProgress) return;
        try {
            await onProgress(msg);
        } catch {
            // Progress sink failures must never abort the loop.
        }
    };

    if (!query || typeof query !== 'string') {
        throw new Error('runDeepSearch: `query` must be a non-empty string.');
    }

    const researchId = randomUUID();
    const factory = createWebResearchTools(researchId, settings, repoKey);
    const toolByName = new Map<string, LocalTool>();
    for (const tool of factory.tools) toolByName.set(tool.name, tool);

    const tools: ChatCompletionFunctionTool[] = [
        ...factory.tools.map(localToolToOpenAi),
        buildSubmitResultTool(settings.maxEvidenceItems),
    ];

    const userPrompt = hint
        ? `Question: ${query}\n\nContext from the chat:\n${hint}`
        : `Question: ${query}`;

    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: buildDeepSearchSystemPrompt(settings) },
        { role: 'user', content: userPrompt },
    ];

    const openai = options.openai ?? makeOpenAiClient(provider);
    let toolCallCount = 0;
    let lastAssistantText = '';

    await emitProgress(`starting investigation — ${provider}/${model}`);

    while (toolCallCount < settings.maxToolCalls) {
        if (signal?.aborted) {
            return finalize({
                summary: lastAssistantText || 'Aborted before completion.',
                evidence: [],
                partial: true,
                reason: 'aborted',
                stats: factory.stats(),
                toolCalls: toolCallCount,
            }, settings);
        }

        let accumulated: { content: string; toolCalls: ChatCompletionMessageFunctionToolCall[] };
        try {
            await emitProgress(`thinking… (round ${toolCallCount + 1})`);
            const stream = await openai.chat.completions.create({
                model,
                messages,
                tools,
                tool_choice: 'auto',
                stream: true,
            }, signal ? { signal } : undefined);
            accumulated = await accumulateStream(stream as unknown as AsyncIterable<ChatCompletionChunk>);
        } catch (err) {
            const detail = describeProviderError(err, provider, model, `inner_loop_iter_${toolCallCount}`);

            return finalize({
                summary: `deep_search aborted: provider error during inner loop.\n${detail}`,
                evidence: [],
                partial: true,
                reason: 'provider_error',
                stats: factory.stats(),
                toolCalls: toolCallCount,
            }, settings);
        }

        if (accumulated.content.length > 0) {
            lastAssistantText = accumulated.content;
        }

        const toolCalls = accumulated.toolCalls;

        if (toolCalls.length === 0) {
            // Model returned plain text without invoking a tool. Push a
            // reminder and try one more turn — but only once. If it does it
            // again, finalize with whatever text we have.
            if (lastAssistantText && messages[messages.length - 1]?.role === 'user') {
                messages.push({
                    role: 'assistant',
                    content: lastAssistantText,
                });
                messages.push({
                    role: 'user',
                    content:
                        'You must call `submit_result` to finish. Plain-text replies are ignored.',
                });
                continue;
            }

            return finalize({
                summary: lastAssistantText || 'deep_search produced no answer.',
                evidence: [],
                partial: true,
                reason: 'no_tool_calls',
                stats: factory.stats(),
                toolCalls: toolCallCount,
            }, settings);
        }

        const assistantMsg: ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: accumulated.content,
            tool_calls: toolCalls,
        };
        messages.push(assistantMsg);

        for (const call of toolCalls) {
            toolCallCount += 1;
            const fname = call.function.name;
            const rawArgs = call.function.arguments ?? '';
            const parsed = parseToolArgs(rawArgs);

            if (signal?.aborted) {
                return finalize({
                    summary: lastAssistantText || 'Aborted before completion.',
                    evidence: [],
                    partial: true,
                    reason: 'aborted',
                    stats: factory.stats(),
                    toolCalls: toolCallCount,
                }, settings);
            }

            if (fname === SUBMIT_RESULT_NAME) {
                await emitProgress('submitting result');
                const payload: SubmitResultPayload = (parsed ?? {}) as SubmitResultPayload;
                const submitInput: FinalizeInput = {
                    summary: typeof payload.summary === 'string' ? payload.summary : '',
                    evidence: coerceEvidence(payload.evidence, settings.maxEvidenceItems, settings.maxExcerptLines),
                    stats: factory.stats(),
                    toolCalls: toolCallCount,
                };
                if (payload.partial === true) submitInput.partial = true;
                if (payload.confidence === 'low' || payload.confidence === 'medium' || payload.confidence === 'high') {
                    submitInput.confidence = payload.confidence;
                }
                if (typeof payload.reason === 'string') submitInput.reason = payload.reason;

                return finalize(submitInput, settings);
            }

            const tool = toolByName.get(fname);
            let result: string;
            if (!tool) {
                result = JSON.stringify({ error: `Unknown tool: ${fname}` });
                await emitProgress(`unknown tool: ${fname}`);
            } else if (parsed === null) {
                result = JSON.stringify({ error: `Invalid JSON arguments for ${fname}.` });
                await emitProgress(`invalid args for ${fname}`);
            } else {
                let approvedArgs: Record<string, unknown> = parsed;
                let denied: string | null = null;
                if (nvim && approval) {
                    const decision = await requestChatToolApproval(nvim, approval, {
                        toolName: fname,
                        toolArgs: parsed,
                        agentLabel: 'deep_search',
                    });
                    if (decision.action === 'deny') {
                        denied = decision.denyReason
                            ? `User denied ${fname}. Reason: "${decision.denyReason}".`
                            : `User denied ${fname}.`;
                    } else if (decision.modifiedArgs && typeof decision.modifiedArgs === 'object') {
                        approvedArgs = decision.modifiedArgs as Record<string, unknown>;
                    }
                }

                if (denied) {
                    result = JSON.stringify({ error: denied });
                    await emitProgress(`✕ ${fname} denied by user`);
                } else {
                    await emitProgress(`→ ${fname}(${summarizeToolArgs(approvedArgs)})`);
                    try {
                        result = await tool.handler(approvedArgs);
                        await emitProgress(`← ${fname} returned ${result.length} chars`);
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        result = JSON.stringify({ error: `Tool ${fname} failed: ${message}` });
                        await emitProgress(`✕ ${fname} failed: ${message}`);
                    }
                }
            }

            const toolMsg: ChatCompletionToolMessageParam = {
                role: 'tool',
                tool_call_id: call.id,
                content: result,
            };
            messages.push(toolMsg);

            if (toolCallCount >= settings.maxToolCalls) {
                // Bump the model with one final user message asking it to
                // submit_result with whatever it has.
                messages.push({
                    role: 'user',
                    content:
                        'You have exhausted the tool budget. Call `submit_result` now with `partial: true` and the best evidence collected so far.',
                });
                break;
            }
        }
    }

    // Loop exited due to budget without a submit_result. Make ONE final
    // attempt to coax submission — streamed, no further tool execution.
    let finalAccumulated: { content: string; toolCalls: ChatCompletionMessageFunctionToolCall[] };
    try {
        await emitProgress('budget exhausted — coaxing final submission');
        const finalStream = await openai.chat.completions.create({
            model,
            messages,
            tools,
            tool_choice: { type: 'function', function: { name: SUBMIT_RESULT_NAME } },
            stream: true,
        }, signal ? { signal } : undefined);
        finalAccumulated = await accumulateStream(finalStream as unknown as AsyncIterable<ChatCompletionChunk>);
    } catch (err) {
        const detail = describeProviderError(err, provider, model, 'budget_coax');
        const base = lastAssistantText || 'deep_search exhausted budget without producing a result.';

        return finalize({
            summary: `${base}\n[final coax failed] ${detail}`,
            evidence: [],
            partial: true,
            reason: 'budget_exhausted',
            stats: factory.stats(),
            toolCalls: toolCallCount,
        }, settings);
    }

    const finalCall = finalAccumulated.toolCalls.find(
        (c) => c.function.name === SUBMIT_RESULT_NAME,
    );
    if (finalCall) {
        const parsed = parseToolArgs(finalCall.function.arguments ?? '') ?? {};
        const payload = parsed as SubmitResultPayload;
        const finalInput: FinalizeInput = {
            summary: typeof payload.summary === 'string' ? payload.summary : (lastAssistantText || ''),
            evidence: coerceEvidence(payload.evidence, settings.maxEvidenceItems, settings.maxExcerptLines),
            partial: true,
            reason: 'budget_exhausted',
            stats: factory.stats(),
            toolCalls: toolCallCount,
        };
        if (payload.confidence === 'low' || payload.confidence === 'medium' || payload.confidence === 'high') {
            finalInput.confidence = payload.confidence;
        }

        return finalize(finalInput, settings);
    }

    return finalize({
        summary: lastAssistantText || 'deep_search exhausted budget without producing a result.',
        evidence: [],
        partial: true,
        reason: 'budget_exhausted',
        stats: factory.stats(),
        toolCalls: toolCallCount,
    }, settings);
}

interface FinalizeInput {
    summary: string;
    evidence: DeepSearchEvidenceItem[];
    confidence?: 'low' | 'medium' | 'high';
    partial?: boolean;
    reason?: string;
    stats: ReturnType<ReturnType<typeof createWebResearchTools>['stats']>;
    toolCalls: number;
}

function finalize(input: FinalizeInput, _settings: DeepSearchSettings): DeepSearchResult {
    const result: DeepSearchResult = {
        summary: input.summary,
        evidence: input.evidence,
        stats: {
            toolCalls: input.toolCalls,
            searches: input.stats.searches,
            scrapes: input.stats.scrapes,
            pagesFetched: input.stats.pagesFetched,
            pagesFailed: input.stats.pagesFailed,
            chunksIndexed: input.stats.chunksIndexed,
        },
    };
    if (input.confidence) result.confidence = input.confidence;
    if (input.partial) result.partial = true;
    if (input.reason) result.reason = input.reason;

    return result;
}
