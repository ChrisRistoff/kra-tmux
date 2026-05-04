import * as neovim from 'neovim';
import OpenAI from 'openai';
import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
    ChatCompletionTool,
    ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import { StreamController } from '@/AI/shared/types/aiTypes';
import { getProviderApiKey, getProviderBaseURL } from '@/AI/shared/data/providers';
import {
    runWebFetch,
    runWebSearch,
    WEB_FETCH_DESCRIPTION,
    WEB_FETCH_PARAMETERS,
    WEB_SEARCH_DESCRIPTION,
    WEB_SEARCH_PARAMETERS,
    type WebFetchArgs,
    type WebSearchArgs,
    type WebToolResult,
} from '@/AI/shared/utils/webTools';
import { loadSettings } from '@/utils/common';
import { buildDocsSearchTool } from '@/AI/AIAgent/shared/utils/memoryMcpServer';
import { docsSearch } from '@/AI/AIAgent/shared/docs/search';
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { summarizeToolCall, formatToolLine } from '@/AI/AIAgent/shared/utils/agentUi';

const MAX_TOOL_ITERATIONS = 8;

/**
 * Extract tool calls from text-based patterns that some providers/models
 * emit in the content field instead of structured `tool_calls` deltas.
 *
 * Pattern: <|tool_call_begin|>call_id<|tool_call_argument_begin|>{json}<|tool_call_end|>
 */
function extractChatTextToolCalls(text: string): Array<{ id: string; name: string; args: string }> {
    const calls: Array<{ id: string; name: string; args: string }> = [];
    const beginRe = /<\|tool_call_begin\|>/g;
    let match: RegExpExecArray | null;
    while ((match = beginRe.exec(text)) !== null) {
        const startIdx = match.index + match[0].length;
        const argBeginIdx = text.indexOf('<|tool_call_argument_begin|>', startIdx);
        if (argBeginIdx === -1) break;
        const callId = text.slice(startIdx, argBeginIdx).trim();
        const endIdx = text.indexOf('<|tool_call_end|>', argBeginIdx);
        if (endIdx === -1) break;
        const argsStr = text.slice(
            argBeginIdx + '<|tool_call_argument_begin|>'.length,
            endIdx
        ).trim();
        let name = '';
        let args = '';
        try {
            const parsed = JSON.parse(argsStr);
            if (typeof parsed === 'object' && parsed !== null) {
                if (typeof parsed.name === 'string') {
                    name = parsed.name;
                    args = typeof parsed.arguments === 'string'
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments ?? {});
                } else {
                    args = JSON.stringify(parsed);
                }
            }
        } catch {
            args = argsStr;
        }
        if (name || args) {
            calls.push({
                id: callId || `call_${Date.now()}_${calls.length}`,
                name: name || '(unknown)',
                args: args || '{}',
            });
        }
    }

    return calls;
}

const TOOL_AWARENESS_PREAMBLE = [
    'You have access to web tools: `web_search` (DuckDuckGo) and `web_fetch` (retrieve a URL as text).',
    'Use them whenever the user asks about current events, specific URLs, library documentation,',
    'package versions, or anything you may not know reliably from training data — do not guess.',
    'Prefer `web_search` to discover relevant pages, then `web_fetch` to read the most promising results.',
    'You MUST invoke tools through the function-calling interface (the structured `tool_calls` field).',
    'Never write tool invocations as plain text, code blocks, JSON, or pseudo-syntax in your reply —',
    'that does NOT execute anything. If you find yourself typing a tool name, stop and emit a real tool call instead.',
    'Lines like `✓ web_search: …` that you may see in earlier turns are passive log markers from the runtime,',
    'not a calling convention you should imitate.',
].join(' ');

const DOCS_SEARCH_PREAMBLE = [
    '',
    'You also have a `docs_search` tool: vector search over documentation pages indexed locally via `kra memory`.',
    'PREFER `docs_search` over `web_search` / `web_fetch` whenever the user’s question matches one of the configured sources listed in the tool’s description — it is faster, offline, and version-pinned to what is installed.',
].join(' ');

const CHAT_TOOLS: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: WEB_FETCH_DESCRIPTION,
            parameters: WEB_FETCH_PARAMETERS as unknown as Record<string, unknown>,
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: WEB_SEARCH_DESCRIPTION,
            parameters: WEB_SEARCH_PARAMETERS as unknown as Record<string, unknown>,
        },
    },
];

export interface ChatToolContext {
    nvim: neovim.NeovimClient;
    chatFile: string;
}

export async function promptModel(
    provider: string,
    model: string,
    messages: ChatCompletionMessageParam[],
    temperature: number,
    system: string,
    controller?: StreamController,
    toolContext?: ChatToolContext,
): Promise<AsyncIterable<string>> {
    const apiKey = getProviderApiKey(provider);
    const baseURL = getProviderBaseURL(provider);

    const openai = new OpenAI({ apiKey, baseURL });

    return createOpenAIStream(openai, model, system, messages, temperature, controller, toolContext);
}

/**
 * Inspect a 400 error message to guess which request parameter the provider
 * rejected.  Returns a set of parameter names that look suspicious.
 *
 * Many OpenAI-compatible providers return vague 400 errors with no detail
 * about *which* parameter was unsupported, so we fall back to keyword
 * heuristics.  When the message is unhelpful we return *all* optional
 * parameters so the caller can strip them one-by-one.
 */
function guessUnsupportedParams(error: unknown): Set<string> {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
    const result = new Set<string>();

    if (/reasoning_effort|reasoning/.test(msg)) result.add('reasoning_effort');
    if (/temperature/.test(msg)) result.add('temperature');
    if (/tool|function[_ ]?call|not[_ ]?support/.test(msg)) result.add('tools');

    // If the message is completely unhelpful, assume all optional params
    // could be the culprit so we try stripping them one-by-one.
    if (result.size === 0) {
        result.add('reasoning_effort');
        result.add('temperature');
        result.add('tools');
    }

    return result;
}

interface ToolCallAccumulator {
    id: string;
    name: string;
    argsBuffer: string;
}

async function executeToolCall(
    toolName: string,
    rawArgs: string,
): Promise<WebToolResult> {
    let parsed: Record<string, unknown> = {};

    try {
        parsed = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { output: `Invalid JSON arguments for ${toolName}: ${message}`, isError: true };
    }

    if (toolName === 'web_fetch') {
        if (typeof parsed.url !== 'string') {
            return { output: 'web_fetch missing required argument: url', isError: true };
        }

        const args: WebFetchArgs = { url: parsed.url };

        if (typeof parsed.max_length === 'number') {
            args.max_length = parsed.max_length;
        }

        return runWebFetch(args);
    }

    if (toolName === 'web_search') {
        if (typeof parsed.query !== 'string') {
            return { output: 'web_search missing required argument: query', isError: true };
        }

        const args: WebSearchArgs = { query: parsed.query };

        if (typeof parsed.max_results === 'number') {
            args.max_results = parsed.max_results;
        }

        return runWebSearch(args);
    }

    if (toolName === 'docs_search') {
        if (typeof parsed.query !== 'string') {
            return { output: 'docs_search missing required argument: query', isError: true };
        }
        const docsArgs: { query: string, k?: number, sourceAlias?: string } = { query: parsed.query };
        if (typeof parsed.k === 'number') docsArgs.k = parsed.k;
        if (typeof parsed.sourceAlias === 'string') docsArgs.sourceAlias = parsed.sourceAlias;
        try {
            const hits = await docsSearch(docsArgs);

            return { output: JSON.stringify(hits, null, 2), isError: false };
        } catch (err) {
            return { output: `docs_search failed: ${(err as Error).message}`, isError: true };
        }
    }

    return { output: `Unknown tool: ${toolName}`, isError: true };
}

async function createOpenAIStream(
    openai: OpenAI,
    llmModel: string,
    system: string,
    initialMessages: ChatCompletionMessageParam[],
    temperature: number,
    controller?: StreamController,
    toolContext?: ChatToolContext,
): Promise<AsyncIterable<string>> {
    const useTools = !!toolContext;

    const chatTools: ChatCompletionTool[] = [...CHAT_TOOLS];
    let docsPreamble = '';
    if (useTools) {
        try {
            const settings = await loadSettings();
            const docsCfg = settings.ai?.docs;
            const sources = docsCfg?.enabled ? (docsCfg.sources ?? []) : [];
            if (sources.length > 0) {
                const docsTool = buildDocsSearchTool(sources);
                chatTools.push({
                    type: 'function',
                    function: {
                        name: docsTool.name,
                        description: docsTool.description,
                        parameters: docsTool.inputSchema as unknown as Record<string, unknown>,
                    },
                });
                docsPreamble = '\n\n' + DOCS_SEARCH_PREAMBLE;
            }
        } catch { /* docs settings missing — leave web tools only */ }
    }

    const systemContent = useTools
        ? `${system ? `${system}\n\n` : ''}${TOOL_AWARENESS_PREAMBLE}${docsPreamble}`
        : system;
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemContent },
        ...initialMessages,
    ];
    let toolsDisabled = false;
    let temperatureDisabled = false;

    async function openStream(): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
        try {
            return await openai.chat.completions.create({
                messages,
                model: llmModel,
                ...(!temperatureDisabled ? { temperature } : {}),
                stream: true,
                ...(useTools && !toolsDisabled
                    ? { tools: chatTools, tool_choice: 'auto' as const }
                    : {}),
            });
        } catch (error) {
            // Progressive retry: strip the most likely offending parameter
            // and retry.  Many OpenAI-compatible providers reject parameters
            // they don't support with a 400, but give vague error messages.
            if (error instanceof Error) {
                const status = (error as unknown as { status?: number }).status;
                if (status === 400) {
                    const suspected = guessUnsupportedParams(error);

                    if (suspected.has('temperature') && !temperatureDisabled) {
                        temperatureDisabled = true;
                        return openStream();
                    }
                    if (suspected.has('tools') && useTools && !toolsDisabled) {
                        toolsDisabled = true;
                        return openStream();
                    }
                }
                if (status === 502 || status === 503) {
                    throw new Error(
                        `Provider returned ${status} (service unavailable). ` +
                        `The model may be overloaded or temporarily down. ` +
                        `Original: ${error.message}`
                    );
                }
                if (status === 400) {
                    throw new Error(
                        `Provider returned 400 (bad request). ` +
                        `The model may not support the parameters sent (e.g. tools, temperature). ` +
                        `Original: ${error.message}`
                    );
                }
            }

            throw error;
        }
    }
    async function* streamResponse(): AsyncIterable<string> {
        try {
            for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
                if (controller?.isAborted) {
                    return;
                }

                const completion = await openStream();
                const toolCalls = new Map<number, ToolCallAccumulator>();
                let assistantContent = '';
                let finishReason: string | null | undefined;
                // Some providers reuse the same index for multiple parallel tool calls,
                // causing them to merge into one. Track ids to detect collisions.
                let syntheticIndexCounter = 0;
                const idToIndex = new Map<string, number>();

                for await (const chunk of completion) {
                    if (controller?.isAborted) {
                        return;
                    }

                    // Some OpenAI-compatible providers send chunks with empty choices
                    // (e.g. usage-only chunks). Guard against undefined choice / delta.
                    const choice = chunk.choices[0];
                    if (!choice) {
                        continue;
                    }

                    const delta = choice.delta;
                    if (!delta) {
                        continue;
                    }

                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                        assistantContent += delta.content;
                        yield delta.content;
                    }

                    if (delta.tool_calls) {
                        for (const tcDelta of delta.tool_calls) {
                            // Some providers reuse the same index for multiple parallel
                            // tool calls, causing them to merge into one (e.g. name
                            // becomes "web_fetchweb_fetchweb_fetch"). When a delta
                            // carries an id (start of a new tool call) but the index
                            // is already occupied by a different id, assign a synthetic
                            // index to keep them separate.
                            let effectiveIndex: number;

                            if (tcDelta.id) {
                                const knownIndex = idToIndex.get(tcDelta.id);
                                if (knownIndex !== undefined) {
                                    effectiveIndex = knownIndex;
                                } else {
                                    const existing = toolCalls.get(tcDelta.index ?? 0);
                                    if (existing && existing.id && existing.id !== tcDelta.id) {
                                        effectiveIndex = 1000 + syntheticIndexCounter++;
                                    } else {
                                        effectiveIndex = tcDelta.index ?? 0;
                                    }
                                    idToIndex.set(tcDelta.id, effectiveIndex);
                                }
                            } else {
                                const existingEntry = toolCalls.get(tcDelta.index ?? 0);
                                const knownIndex = idToIndex.get(existingEntry?.id ?? '');
                                effectiveIndex = knownIndex ?? (tcDelta.index ?? 0);
                            }

                            const existing = toolCalls.get(effectiveIndex) ?? {
                                id: '',
                                name: '',
                                argsBuffer: '',
                            };

                            if (tcDelta.id) {
                                existing.id = tcDelta.id;
                            }

                            if (tcDelta.function?.name) {
                                existing.name += tcDelta.function.name;
                            }

                            if (typeof tcDelta.function?.arguments === 'string') {
                                existing.argsBuffer += tcDelta.function.arguments;
                            }

                            toolCalls.set(effectiveIndex, existing);
                        }
                    }

                    if (choice.finish_reason) {
                        finishReason = choice.finish_reason;
                    }
                }

                if (finishReason !== 'tool_calls' || toolCalls.size === 0 || !toolContext) {
                    // No structured tool calls — check for text-based tool call patterns
                    // that some providers emit in the content field instead.
                    if (toolContext && assistantContent.length > 0) {
                        const extracted = extractChatTextToolCalls(assistantContent);
                        if (extracted.length > 0) {
                            // Strip the tool call text from the content we yield
                            const cleanedContent = assistantContent.replace(
                                /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g,
                                ''
                            ).replace(/\n{3,}/g, '\n\n').trim();
                            if (cleanedContent) {
                                // Already yielded during streaming, no need to yield again
                            }

                            const assistantMessage: ChatCompletionAssistantMessageParam = {
                                role: 'assistant',
                                content: cleanedContent || null,
                                tool_calls: extracted.map<ChatCompletionMessageToolCall>((tc) => ({
                                    id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                                    type: 'function',
                                    function: { name: tc.name, arguments: tc.args || '{}' },
                                })),
                            };
                            messages.push(assistantMessage);

                            for (const tc of assistantMessage.tool_calls!) {
                                if (controller?.isAborted) {
                                    return;
                                }

                                let parsedArgs: Record<string, unknown> = {};
                                try {
                                    parsedArgs = tc.function.arguments
                                        ? JSON.parse(tc.function.arguments) as Record<string, unknown>
                                        : {};
                                } catch {
                                    // summarizeToolCall handles missing fields gracefully
                                }

                                const summary = summarizeToolCall(tc.function.name, parsedArgs);

                                await updateAgentUi(toolContext.nvim, 'start_tool', [
                                    tc.function.name,
                                    summary,
                                    tc.function.arguments || '{}',
                                ]);

                                const result = await executeToolCall(tc.function.name, tc.function.arguments);

                                await updateAgentUi(toolContext.nvim, 'complete_tool', [
                                    tc.function.name,
                                    summary,
                                    !result.isError,
                                    result.output,
                                ]);

                                yield formatToolLine(summary, !result.isError);

                                const toolMessage: ChatCompletionToolMessageParam = {
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: result.output,
                                };
                                messages.push(toolMessage);
                            }

                            // Continue the loop to let the model respond to tool results
                        }
                    }

                    return;
                }

                const orderedCalls = [...toolCalls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, value]) => value);

                const assistantMessage: ChatCompletionAssistantMessageParam = {
                    role: 'assistant',
                    content: assistantContent || null,
                    tool_calls: orderedCalls.map<ChatCompletionMessageToolCall>((tc) => ({
                        id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.argsBuffer || '{}' },
                    })),
                };

                messages.push(assistantMessage);

                for (const tc of assistantMessage.tool_calls!) {
                    if (controller?.isAborted) {
                        return;
                    }

                    let parsedArgs: Record<string, unknown> = {};
                    try {
                        parsedArgs = tc.function.arguments
                            ? JSON.parse(tc.function.arguments) as Record<string, unknown>
                            : {};
                    } catch {
                        // summarizeToolCall handles missing fields gracefully
                    }

                    const summary = summarizeToolCall(tc.function.name, parsedArgs);

                    await updateAgentUi(toolContext.nvim, 'start_tool', [
                        tc.function.name,
                        summary,
                        tc.function.arguments || '{}',
                    ]);

                    const result = await executeToolCall(tc.function.name, tc.function.arguments);

                    await updateAgentUi(toolContext.nvim, 'complete_tool', [
                        tc.function.name,
                        summary,
                        !result.isError,
                        result.output,
                    ]);

                    yield formatToolLine(summary, !result.isError);

                    const toolMessage: ChatCompletionToolMessageParam = {
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: result.output,
                    };
                    messages.push(toolMessage);
                }
            }
        } catch (error) {
            if (controller?.isAborted) {
                return;
            }

            // Provide clearer error messages for common provider failures.
            if (error instanceof Error) {
                const status = (error as unknown as { status?: number }).status;
                if (status === 502 || status === 503) {
                    throw new Error(
                        `Provider returned ${status} (service unavailable). ` +
                        `The model may be overloaded or temporarily down. ` +
                        `Original: ${error.message}`
                    );
                }
                if (status === 400) {
                    throw new Error(
                        `Provider returned 400 (bad request). ` +
                        `The model may not support the parameters sent (e.g. tools, temperature). ` +
                        `Original: ${error.message}`
                    );
                }
            }

            throw error;
        }
    }

    return streamResponse();
}

