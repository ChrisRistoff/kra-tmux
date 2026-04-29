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
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { summarizeToolCall, formatToolLine } from '@/AI/AIAgent/shared/utils/agentUi';

const MAX_TOOL_ITERATIONS = 8;

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

function looksLikeToolsUnsupported(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');

    return /tool|function[_ ]?call|not[_ ]?support/i.test(message);
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
    const systemContent = useTools
        ? `${system ? `${system}\n\n` : ''}${TOOL_AWARENESS_PREAMBLE}`
        : system;
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemContent },
        ...initialMessages,
    ];
    let toolsDisabled = false;

    async function openStream(): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
        try {
            return await openai.chat.completions.create({
                messages,
                model: llmModel,
                temperature,
                stream: true,
                ...(useTools && !toolsDisabled
                    ? { tools: CHAT_TOOLS, tool_choice: 'auto' as const }
                    : {}),
            });
        } catch (error) {
            if (useTools && !toolsDisabled && looksLikeToolsUnsupported(error)) {
                toolsDisabled = true;

                return openai.chat.completions.create({
                    messages,
                    model: llmModel,
                    temperature,
                    stream: true,
                });
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

                for await (const chunk of completion) {
                    if (controller?.isAborted) {
                        return;
                    }

                    const choice = chunk.choices[0];
                    const delta = choice?.delta;

                    if (!delta) {
                        continue;
                    }

                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                        assistantContent += delta.content;
                        yield delta.content;
                    }

                    if (delta.tool_calls) {
                        for (const tcDelta of delta.tool_calls) {
                            const index = tcDelta.index ?? 0;
                            const existing = toolCalls.get(index) ?? {
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

                            toolCalls.set(index, existing);
                        }
                    }

                    if (choice?.finish_reason) {
                        finishReason = choice.finish_reason;
                    }
                }

                if (finishReason !== 'tool_calls' || toolCalls.size === 0 || !toolContext) {
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

            throw error;
        }
    }

    return streamResponse();
}

