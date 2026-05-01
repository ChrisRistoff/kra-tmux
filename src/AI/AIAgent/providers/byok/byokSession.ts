/**
 * OpenAI-compatible BYOK session.
 *
 * Implements `AgentSession` (the provider-neutral contract used by
 * `agentConversation.ts` and the rest of `shared/`). Wraps an OpenAI Chat
 * Completions client (any base URL), drives the streaming tool-call loop, and
 * fires the events the shared UI layer subscribes to.
 *
 * Design notes:
 *   - One session = one OpenAI client + one MCP client pool.
 *   - `send()` runs until the model produces a turn with no tool calls, then
 *     emits `session.idle` and returns.
 *   - Tool calls go through `onPreToolUse`/`onPostToolUse` hooks (same shape
 *     as Copilot SDK), then to the MCP client. Tool denials are surfaced to
 *     the model as the tool result so it can react.
 *   - Reasoning deltas (deepseek-reasoner et al.) are detected via
 *     `delta.reasoning_content` / `delta.reasoning` and routed to
 *     `assistant.reasoning_delta`.
 *   - On context-length errors we compact the history once and retry.
 */

import OpenAI from 'openai';
import type {
    ChatCompletionChunk,
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCall,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';
import {
    type AgentSendOptions,
    type AgentSession,
    type AgentSessionEventMap,
    type AgentSessionOptions,
    type LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { TURN_REMINDER } from '@/AI/AIAgent/shared/main/turnReminder';
import { buildMcpClientPool, type McpClientPool } from '@/AI/AIAgent/providers/byok/mcpClientPool';
import { createExecutableToolBridge, disconnectPool } from '@/AI/AIAgent/mcp/executableToolBridge';
import { compactMessages, estimateTokens, isContextLengthError } from '@/AI/AIAgent/providers/byok/byokCompactor';
import { getFileContextsTaggedBlock } from '@/AI/shared/conversation';

const DEFAULT_SYSTEM_PROMPT = [
    'You are an autonomous coding agent operating inside a proposal workspace.',
    'You may freely read, edit, and create files; the user reviews the resulting',
    'git diff at the end. Use the available tools — do not just describe what you',
    'would do. Always finish by calling confirm_task_complete.',
].join(' ');

export interface OpenAICompatibleSessionOptions {
    sessionOptions: AgentSessionOptions;
    baseURL: string;
    apiKey: string;
}

interface InternalToolCall {
    id: string;
    name: string;
    args: string;
}

type EventListener<K extends keyof AgentSessionEventMap> = (
    e: AgentSessionEventMap[K]
) => void;

export class OpenAICompatibleSession implements AgentSession {
    private readonly openai: OpenAI;
    private readonly opts: AgentSessionOptions;
    private mcp: McpClientPool | undefined;
    private openaiTools: ChatCompletionTool[] = [];
    private messages: ChatCompletionMessageParam[] = [];
    private listeners: { [K in keyof AgentSessionEventMap]?: EventListener<K>[] } = {};
    private abortController: AbortController | undefined;
    private compactedThisTurn = false;
    private readonly executableToolBridge = createExecutableToolBridge(() => this.mcp);
    private localTools: Map<string, LocalTool> = new Map();

    public constructor(opts: OpenAICompatibleSessionOptions) {
        this.opts = opts.sessionOptions;
        this.openai = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    }

    public on: AgentSession['on'] = (event, handler) => {
        const list = (this.listeners[event] ??= []) as EventListener<typeof event>[];
        list.push(handler);
    };

    private emit<K extends keyof AgentSessionEventMap>(
        event: K,
        payload: AgentSessionEventMap[K]
    ): void {
        const list = this.listeners[event];

        if (!list) {
            return;
        }

        for (const handler of list) {
            try {
                handler(payload);
            } catch {
                // listener errors must not break the session loop
            }
        }
    }

    public async init(): Promise<void> {
        const mergedServers = {
            ...this.opts.mcpServers,
            ...(this.opts.additionalMcpServers ?? {}),
        };

        this.mcp = await buildMcpClientPool({
            servers: mergedServers,
            ...(this.opts.excludedTools ? { excludedTools: this.opts.excludedTools } : {}),
            ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
            workingDirectory: this.opts.workingDirectory,
        });

        const mcpOpenaiTools = this.mcp.openaiTools as ChatCompletionTool[];
        const localOpenaiTools: ChatCompletionTool[] = [];

        for (const localTool of this.opts.localTools ?? []) {
            if (this.mcp.tools.has(localTool.name)) {
                throw new Error(
                    `Local tool '${localTool.name}' collides with an MCP tool of the same name.`
                );
            }
            this.localTools.set(localTool.name, localTool);
            localOpenaiTools.push({
                type: 'function',
                function: {
                    name: localTool.name,
                    description: localTool.description,
                    parameters: localTool.parameters,
                },
            });
        }

        this.openaiTools = [...mcpOpenaiTools, ...localOpenaiTools];

        const sysContent = this.buildSystemMessage();
        this.messages.push({ role: 'system', content: sysContent });
    }

    private buildSystemMessage(): string {
        const sm = this.opts.systemMessage;

        if (!sm) {
            return DEFAULT_SYSTEM_PROMPT;
        }

        if (sm.mode === 'replace') {
            return sm.content;
        }

        return `${DEFAULT_SYSTEM_PROMPT}\n\n${sm.content}`;
    }

    private async maybeProactiveCompact(): Promise<void> {
        if (this.compactedThisTurn) {
            return;
        }

        const ctx = this.opts.contextWindow;

        if (!ctx || ctx <= 0) {
            return;
        }

        const thresholdEnv = Number(process.env['KRA_BYOK_COMPACT_THRESHOLD']);
        const threshold = Number.isFinite(thresholdEnv) && thresholdEnv > 0 && thresholdEnv < 1
            ? thresholdEnv
            : 0.70;

        const estimated = estimateTokens(this.messages);

        if (estimated < ctx * threshold) {
            return;
        }

        if (process.env['KRA_BYOK_DEBUG'] === '1') {
            console.error(`[byok] proactive compaction: ~${estimated} tokens > ${Math.round(ctx * threshold)} (${Math.round(threshold * 100)}% of ${ctx})`);
        }

        this.compactedThisTurn = true;
        this.messages = await compactMessages({
            openai: this.openai,
            model: this.opts.model,
            messages: this.messages,
        });
    }

    public send: AgentSession['send'] = async (options: AgentSendOptions) => {
        this.compactedThisTurn = false;
        this.abortController = new AbortController();

        const taggedFiles = await getFileContextsTaggedBlock();
        const userContent = taggedFiles
            ? `${options.prompt}\n\n${taggedFiles}\n\n${TURN_REMINDER}`
            : `${options.prompt}\n\n${TURN_REMINDER}`;

        this.messages.push({
            role: 'user',
            content: userContent,
        });

        try {
            await this.runTurnLoop();
        } finally {
            this.emit('session.idle', undefined);
        }
    };

    private async runTurnLoop(): Promise<void> {
        for (; ;) {
            const toolCalls = await this.streamOnePass();

            if (toolCalls.length === 0) {
                return;
            }

            for (const call of toolCalls) {
                await this.executeToolCall(call);

                if (this.abortController?.signal.aborted) {
                    return;
                }
            }
        }
    }

    private async streamOnePass(): Promise<InternalToolCall[]> {
        await this.maybeProactiveCompact();

        let stream: Stream<ChatCompletionChunk>;

        try {
            stream = await this.openai.chat.completions.create(
                {
                    model: this.opts.model,
                    messages: this.messages,
                    stream: true,
                    ...(this.openaiTools.length > 0 ? { tools: this.openaiTools } : {}),
                },
                { signal: this.abortController?.signal }
            );
        } catch (error) {
            if (!this.compactedThisTurn && isContextLengthError(error)) {
                this.compactedThisTurn = true;
                this.messages = await compactMessages({
                    openai: this.openai,
                    model: this.opts.model,
                    messages: this.messages,
                });

                return this.streamOnePass();
            }

            throw error;
        }

        const accumulatedToolCalls = new Map<number, InternalToolCall>();
        let assistantText = '';
        const debug = process.env.KRA_BYOK_DEBUG === '1';
        let chunkCount = 0;

        for await (const chunk of stream) {
            chunkCount += 1;
            const delta = chunk.choices[0].delta;

            if (debug) {
                process.stderr.write(
                    `[byok] chunk #${chunkCount} content=${JSON.stringify(delta.content ?? null)} tool_calls=${delta.tool_calls?.length ?? 0} finish=${chunk.choices[0].finish_reason ?? ''}\n`
                );
            }

            const reasoning =
                (delta as unknown as { reasoning_content?: string }).reasoning_content ??
                (delta as unknown as { reasoning?: string }).reasoning;

            if (typeof reasoning === 'string' && reasoning.length > 0) {
                this.emit('assistant.reasoning_delta', { data: { deltaContent: reasoning } });
            }

            if (typeof delta.content === 'string' && delta.content.length > 0) {
                assistantText += delta.content;
                this.emit('assistant.message_delta', { data: { deltaContent: delta.content } });
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const existing = accumulatedToolCalls.get(tc.index) ?? {
                        id: '',
                        name: '',
                        args: '',
                    };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                    accumulatedToolCalls.set(tc.index, existing);
                }
            }
        }

        if (debug) {
            process.stderr.write(
                `[byok] stream done: chunks=${chunkCount} text_len=${assistantText.length} tool_calls=${accumulatedToolCalls.size}\n`
            );
        }


        const toolCalls = Array.from(accumulatedToolCalls.values()).filter(
            (tc) => tc.id && tc.name
        );

        const assistantMessage: ChatCompletionMessageParam = {
            role: 'assistant',
            content: assistantText || null,
            ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map<ChatCompletionMessageToolCall>((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.args || '{}' },
                    })),
                }
                : {}),
        };

        this.messages.push(assistantMessage);

        return toolCalls;
    }

    private async executeLocalToolCall(call: InternalToolCall, localTool: LocalTool): Promise<void> {
        const serverLabel = localTool.serverLabel ?? 'kra-local';

        let parsedArgs: unknown;

        try {
            parsedArgs = call.args ? JSON.parse(call.args) : {};
        } catch (error) {
            const msg = `Failed to parse tool arguments: ${(error as Error).message}`;
            this.emitToolStart(call, serverLabel, localTool.name);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const preHook = await this.opts.onPreToolUse({
            toolName: localTool.name,
            toolArgs: parsedArgs,
        });

        if (preHook.permissionDecision === 'deny') {
            const reason = preHook.permissionDecisionReason ?? 'Tool call denied by approval hook.';
            const msg = `Denied: ${reason}`;
            this.emitToolStart(call, serverLabel, localTool.name);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const finalArgs = preHook.modifiedArgs ?? parsedArgs;
        this.emitToolStart(call, serverLabel, localTool.name, finalArgs);

        let toolText: string;
        let isError = false;

        try {
            toolText = await localTool.handler(finalArgs as Record<string, unknown>);

            if (preHook.additionalContext) {
                toolText = `${preHook.additionalContext}\n\n${toolText}`;
            }

            const postHook = await this.opts.onPostToolUse({
                toolName: localTool.name,
                toolResult: { textResultForLlm: toolText },
            });

            if (postHook?.modifiedResult?.textResultForLlm) {
                toolText = postHook.modifiedResult.textResultForLlm;
            }
        } catch (error) {
            toolText = `Tool execution failed: ${(error as Error).message}`;
            isError = true;
        }

        this.appendToolResult(call.id, toolText);
        this.emitToolComplete(call, !isError, toolText);
    }

    private async executeToolCall(call: InternalToolCall): Promise<void> {
        const localTool = this.localTools.get(call.name);

        if (localTool) {
            await this.executeLocalToolCall(call, localTool);

            return;
        }

        const tool = this.mcp?.tools.get(call.name);

        if (!tool) {
            this.emitToolStart(call, '(unknown)', '(unknown tool)');
            this.appendToolResult(call.id, `Tool '${call.name}' is not registered.`);
            this.emitToolComplete(call, false, `Tool '${call.name}' is not registered.`);

            return;
        }

        let parsedArgs: unknown;

        try {
            parsedArgs = call.args ? JSON.parse(call.args) : {};
        } catch (error) {
            const msg = `Failed to parse tool arguments: ${(error as Error).message}`;
            this.emitToolStart(call, tool.server, tool.originalName);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const preHook = await this.opts.onPreToolUse({
            toolName: tool.originalName,
            toolArgs: parsedArgs,
        });

        if (preHook.permissionDecision === 'deny') {
            const reason =
                preHook.permissionDecisionReason ?? 'Tool call denied by approval hook.';
            const msg = `Denied: ${reason}`;
            this.emitToolStart(call, tool.server, tool.originalName);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const finalArgs = preHook.modifiedArgs ?? parsedArgs;

        this.emitToolStart(call, tool.server, tool.originalName, finalArgs);

        let toolText: string;
        let isError = false;

        try {
            const result = await tool.client.callTool({
                name: tool.originalName,
                arguments: finalArgs as Record<string, unknown>,
            });

            const contentArray = (result.content ?? []) as Array<{
                type: string;
                text?: string;
            }>;

            toolText = contentArray
                .filter((p) => p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text)
                .join('\n');

            isError = Boolean(result.isError);

            if (preHook.additionalContext) {
                toolText = `${preHook.additionalContext}\n\n${toolText}`;
            }

            const postHook = await this.opts.onPostToolUse({
                toolName: tool.originalName,
                toolResult: { textResultForLlm: toolText, raw: result },
            })

            if (postHook?.modifiedResult?.textResultForLlm) {
                toolText = postHook.modifiedResult.textResultForLlm;
            }
        } catch (error) {
            toolText = `Tool execution failed: ${(error as Error).message}`;
            isError = true;
        }

        this.appendToolResult(call.id, toolText);
        this.emitToolComplete(call, !isError, toolText);
    }

    private emitToolStart(
        call: InternalToolCall,
        mcpServerName: string,
        mcpToolName: string,
        args?: unknown
    ): void {
        let parsedArgs: unknown = args;

        if (parsedArgs === undefined) {
            try {
                parsedArgs = call.args ? JSON.parse(call.args) : {};
            } catch {
                parsedArgs = call.args;
            }
        }

        this.emit('tool.execution_start', {
            data: {
                toolCallId: call.id,
                toolName: mcpToolName,
                mcpServerName,
                mcpToolName,
                arguments: (parsedArgs ?? {}) as Record<string, unknown>,
            },
        });
    }

    private emitToolComplete(call: InternalToolCall, success: boolean, output: string): void {
        this.emit('tool.execution_complete', {
            data: {
                toolCallId: call.id,
                success,
                result: { content: output },
            },
        });
    }

    private appendToolResult(toolCallId: string, content: string): void {
        this.messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content,
        });
    }

    public abort: AgentSession['abort'] = async () => {
        this.abortController?.abort();
    };

    public disconnect: AgentSession['disconnect'] = async () => {
        this.abortController?.abort();
        await disconnectPool(this.mcp);
    };

    public listExecutableTools: NonNullable<AgentSession['listExecutableTools']> = () => {
        return this.executableToolBridge.listExecutableTools();
    };

    public executeTool: NonNullable<AgentSession['executeTool']> = async (title, args) => {
        return this.executableToolBridge.executeTool(title, args);
    };
}
