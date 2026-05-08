/**
 * Claude Agent SDK provider — bridges `@anthropic-ai/claude-agent-sdk`'s
 * `query()` (an `AsyncGenerator<SDKMessage>`) to the repo's
 * `AgentSession` event-based contract used by the orchestrator and chat UI.
 *
 * Design notes:
 * - Copilot SDK already exposes `.on('event', handler)`; Claude SDK does not.
 *   This bridge spawns a background task that drains the generator and
 *   re-emits via a node `EventEmitter`, mapping `SDKMessage` variants onto
 *   the repo's `AgentSessionEventMap` keys.
 * - Multi-turn `send()` uses the streaming-input form of `query()`: we keep
 *   an open `AsyncIterable<SDKUserMessage>` for the lifetime of the session
 *   and push prompts into it via a small promise-queue.
 * - `abort()` calls `Query.interrupt()`; `disconnect()` closes the input
 *   queue (which lets the SDK finish the subprocess shutdown) and tears
 *   down any side-channel MCP pool installed by the wrapper.
 *
 * This is a SKELETON. The event-mapping (`mapSdkMessage`) only covers the
 * common cases (assistant text deltas, tool_use, tool_result, session end);
 * fill in the long tail of `SDKMessage` variants as they actually appear in
 * captured traces from real sessions.
 */

import { EventEmitter } from 'events';
import {
    query,
    type Query,
    type Options as ClaudeSdkOptions,
    type SDKMessage,
    type SDKUserMessage,
    type SDKAssistantMessage,
    type SDKRateLimitEvent,
} from '@anthropic-ai/claude-agent-sdk';
import type {
    AgentSession,
    AgentSessionEventMap,
    AgentSendOptions,
} from '@/AI/AIAgent/shared/types/agentTypes';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions';

export interface ClaudeSessionBridgeInit {
    sdkOptions: ClaudeSdkOptions;
    /**
     * Called once during bridge construction to set up any side-channel MCP
     * pool the wrapper needs (e.g. the `kra-*` pool used by
     * `listExecutableTools`/`executeTool`). The returned `dispose` runs
     * during `disconnect()`.
     */
    onInit?: () => Promise<{ dispose: () => Promise<void> }> | undefined;
}

type Listener<K extends keyof AgentSessionEventMap> = (
    e: AgentSessionEventMap[K]
) => void;

/**
 * Promise-backed async iterable used as the streaming input to `query()`.
 * `send()` calls push items; `close()` ends the iterator so the SDK
 * subprocess can drain and shut down cleanly.
 */
class PromptStream implements AsyncIterable<SDKUserMessage> {
    private resolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
    private pending: SDKUserMessage[] = [];
    private closed = false;

    public push(message: SDKUserMessage): void {
        if (this.closed) {
            throw new Error('PromptStream is closed');
        }
        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({ value: message, done: false });
        } else {
            this.pending.push(message);
        }
    }

    public close(): void {
        this.closed = true;
        while (this.resolvers.length > 0) {
            const r = this.resolvers.shift();
            if (r) {
                r({ value: undefined as unknown as SDKUserMessage, done: true });
            }
        }
    }

    public [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        const self = this;

        return {
            async next(): Promise<IteratorResult<SDKUserMessage>> {
                const queued = self.pending.shift();
                if (queued) {
                    return Promise.resolve({ value: queued, done: false });
                }
                if (self.closed) {
                    return Promise.resolve({
                        value: undefined as unknown as SDKUserMessage,
                        done: true,
                    });
                }

                return new Promise((resolve) => {
                    self.resolvers.push(resolve);
                });
            },
        };
    }
}

export class ClaudeSessionBridge implements AgentSession {
    private readonly emitter = new EventEmitter();
    private readonly prompts = new PromptStream();
    private readonly transcript: ChatCompletionMessageParam[] = [];
    private readonly sdkQuery: Query;
    private disposeSidePool: (() => Promise<void>) | undefined;
    private drainPromise: Promise<void> | undefined;
    private currentToolCalls = new Map<string, { name: string; serverName: string }>();

    /** Optional AgentSession members — assigned by the wrapper after the side-channel MCP pool spins up. */
    public listExecutableTools?: NonNullable<AgentSession['listExecutableTools']>;
    public executeTool?: NonNullable<AgentSession['executeTool']>;

    public constructor(init: ClaudeSessionBridgeInit) {
        this.sdkQuery = query({
            prompt: this.prompts,
            options: init.sdkOptions,
        });

        if (init.onInit) {
            // Fire and forget — the side pool is best-effort.
            void Promise.resolve(init.onInit()).then((handle) => {
                if (handle) {
                    this.disposeSidePool = handle.dispose;
                }
            });
        }

        this.drainPromise = this.drain();
    }

    private async drain(): Promise<void> {
        try {
            for await (const msg of this.sdkQuery) {
                this.dispatch(msg);
            }
        } catch (err) {
            // The Claude SDK can throw during async iteration on transport drops,
            // auth expiry mid-session, malformed messages, etc. Surface it on the
            // event channel so the orchestrator/UI can show something other than
            // a session that silently went idle.
            const message = err instanceof Error ? err.message : String(err);
            console.error('[claude-bridge] drain loop crashed:', err);
            this.emit('session.error', {
                data: { source: 'drain', message, cause: err },
            });
        } finally {
            this.emit('session.idle', undefined);
        }
    }

    private dispatch(msg: SDKMessage): void {
        switch (msg.type) {
            case 'assistant':
                this.handleAssistantMessage(msg);

                return;
            case 'user':
                // Tool results land here as user messages with
                // `tool_use_result` populated. Map to tool.execution_complete.
                this.handleUserMessage(msg);

                return;
            case 'result':
                this.handleResultMessage(msg);

                return;
            case 'rate_limit_event':
                this.handleRateLimitEvent(msg);

                return;
            case 'system':
                this.handleSystemMessage(msg);

                return;
            case 'stream_event':
                this.handleStreamEvent(msg as SDKMessage & { type: 'stream_event'; event: { type: string; delta?: { type: string; text?: string; thinking?: string } } });

                return;
            case 'auth_status':
                if (typeof (msg as { error?: unknown }).error === 'string') {
                    this.emit('session.error', {
                        data: {
                            source: 'auth',
                            message: (msg as { error: string }).error,
                            cause: msg,
                        },
                    });
                }

                return;
            default:
                // Remaining SDK message variants (status, hook lifecycle,
                // plugin install, partial_assistant_message, task_*, etc.)
                // either duplicate information we already get from
                // `assistant`/`user`/`result` or only matter for SDK features
                // we do not use. Add cases here if a real session needs them.
                return;
        }
    }

    private handleResultMessage(msg: SDKMessage & { type: 'result' }): void {
        // SDKResultMessage = SDKResultSuccess | SDKResultError. Successes drop
        // straight to idle; errors get surfaced on the error channel first so
        // the UI can render something instead of silently stopping.
        if (msg.subtype !== 'success') {
            const errs = (msg as { errors?: unknown }).errors;
            const summary = Array.isArray(errs) && errs.length > 0
                ? errs.map((e: unknown) => String(e)).join('; ')
                : msg.subtype;
            this.emit('session.error', {
                data: {
                    source: 'sdk',
                    message: `Claude session ended with ${msg.subtype}: ${summary}`,
                    cause: msg,
                },
            });
        }
        this.emit('session.idle', undefined);
    }

    private handleSystemMessage(msg: SDKMessage & { type: 'system' }): void {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === 'mirror_error') {
            // Internal SDK mirror/sync failure. Not fatal but worth surfacing
            // so the UI can show degraded-state messaging.
            this.emit('session.error', {
                data: {
                    source: 'mirror',
                    message: String((msg as { error?: unknown }).error ?? 'mirror_error'),
                    cause: msg,
                },
            });

            return;
        }
        if (subtype === 'api_retry') {
            const m = msg as { attempt?: number; max_retries?: number; error?: string };
            this.emit('session.error', {
                data: {
                    source: 'sdk',
                    message: `Claude API retry ${m.attempt ?? '?'}/${m.max_retries ?? '?'}: ${m.error ?? 'unknown'}`,
                    cause: msg,
                },
            });
        }
        // Other system subtypes (init, etc.) are noise we don't surface.
    }

    private handleRateLimitEvent(msg: SDKRateLimitEvent): void {
        const info = msg.rate_limit_info;
        const utilization = typeof info.utilization === 'number' ? info.utilization : 0;
        const remainingPercentage = Math.max(0, Math.min(100, (1 - utilization) * 100));
        const resetDate = typeof info.resetsAt === 'number'
            ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString()
            : undefined;
        const key = `claude:${info.rateLimitType ?? 'unknown'}`;
        const snapshots: Record<string, { remainingPercentage: number; resetDate?: string; isUnlimitedEntitlement: boolean }> = {
            [key]: {
                remainingPercentage,
                ...(resetDate ? { resetDate } : {}),
                isUnlimitedEntitlement: false,
            },
        };

        if (info.isUsingOverage && typeof info.overageResetsAt === 'number') {
            const overageRemaining = info.overageStatus === 'rejected' ? 0 : (info.overageStatus === 'allowed_warning' ? 10 : 100);
            snapshots['claude:overage'] = {
                remainingPercentage: overageRemaining,
                resetDate: new Date(info.overageResetsAt * (info.overageResetsAt < 1e12 ? 1000 : 1)).toISOString(),
                isUnlimitedEntitlement: false,
            };
        }

        this.emit('assistant.usage', { data: { quotaSnapshots: snapshots } });
    }

    private handleStreamEvent(msg: { event: { type: string; delta?: { type: string; text?: string; thinking?: string } } }): void {
        // SDK partial messages wrap Anthropic's raw streaming events. We only
        // forward incremental text/thinking deltas; the SDK still emits a
        // final consolidated `assistant` message which we use for tool_use
        // dispatch and transcript capture (without re-emitting deltas).
        const ev = msg.event;
        if (ev.type !== 'content_block_delta' || !ev.delta) {
            return;
        }
        if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
            this.emit('assistant.message_delta', {
                data: { deltaContent: ev.delta.text },
            });
        } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
            this.emit('assistant.reasoning_delta', {
                data: { deltaContent: ev.delta.thinking },
            });
        }
    }

    private handleAssistantMessage(msg: SDKAssistantMessage): void {
        // Note: text/thinking deltas are emitted live from `stream_event`
        // above (see `includePartialMessages: true` in claudeClient). Here
        // we only collect transcript fragments and dispatch tool_use blocks.
        const content = msg.message.content;
        if (!Array.isArray(content)) {
            return;
        }
        const transcriptParts: string[] = [];
        for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
                transcriptParts.push(block.text);
            } else if (block.type === 'tool_use') {
                const callId = String(block.id);
                const toolName = String(block.name);
                // Claude SDK names MCP tools as `mcp__<server>__<tool>`. Strip
                // the `mcp__` prefix and split on the first `__` to recover
                // (server, tool). Built-in / non-MCP tools have no prefix.
                let serverName = '';
                let mcpToolName = toolName;
                if (toolName.startsWith('mcp__')) {
                    const rest = toolName.slice('mcp__'.length);
                    const sep = rest.indexOf('__');
                    if (sep > 0) {
                        serverName = rest.slice(0, sep);
                        mcpToolName = rest.slice(sep + 2);
                    }
                }
                this.currentToolCalls.set(callId, { name: toolName, serverName });
                this.emit('tool.execution_start', {
                    data: {
                        toolName,
                        mcpServerName: serverName,
                        mcpToolName,
                        toolCallId: callId,
                        arguments: (block.input ?? {}) as Record<string, unknown>,
                    },
                });
                transcriptParts.push(`[tool_call: ${toolName}]`);
            }
        }
        if (transcriptParts.length > 0) {
            this.transcript.push({
                role: 'assistant',
                content: transcriptParts.join('\n'),
            });
        }
    }

    private handleUserMessage(msg: { message: { content: unknown } }): void {
        const content = msg.message.content;
        if (!Array.isArray(content)) {
            return;
        }
        for (const block of content as Array<Record<string, unknown>>) {
            if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
                const callId = block['tool_use_id'];
                const isError = block['is_error'] === true;
                const rawContent = block['content'];
                const text = typeof rawContent === 'string'
                    ? rawContent
                    : Array.isArray(rawContent)
                        ? rawContent
                              .map((c: unknown) =>
                                  typeof c === 'object' && c && 'text' in (c as Record<string, unknown>)
                                      ? String((c as Record<string, unknown>)['text'] ?? '')
                                      : '')
                              .join('')
                        : '';
                this.currentToolCalls.delete(callId);
                this.emit('tool.execution_complete', {
                    data: {
                        toolCallId: callId,
                        success: !isError,
                        ...(isError
                            ? { error: text }
                            : { result: { content: text } }),
                    },
                });
            }
        }
    }

    private emit<K extends keyof AgentSessionEventMap>(
        event: K,
        payload: AgentSessionEventMap[K]
    ): void {
        this.emitter.emit(event, payload);
    }

    // ─── AgentSession contract ───────────────────────────────────────────

    public on<K extends keyof AgentSessionEventMap>(
        event: K,
        handler: Listener<K>
    ): void {
        this.emitter.on(event, handler as (e: unknown) => void);
    }

    public async send(options: AgentSendOptions): Promise<void> {
        this.transcript.push({ role: 'user', content: options.prompt });
        this.prompts.push({
            type: 'user',
            message: {
                role: 'user',
                content: options.prompt,
            },
            parent_tool_use_id: null,
        });
    }

    /**
     * Returns a best-effort OpenAI-shaped transcript of the conversation so
     * far. Used for save/export. Note that the Claude Agent SDK manages its
     * own session state internally (with auto-compaction) and the SDK's true
     * resume mechanism is `sessionId` + `resume`, not replay of these
     * messages. Tool calls are flattened into assistant text.
     */
    public getMessages(): ChatCompletionMessageParam[] {
        return [...this.transcript];
    }

    public async abort(): Promise<void> {
        try {
            await this.sdkQuery.interrupt();
        } catch {
            // swallow — interrupt can race with natural completion
        }
    }

    public async disconnect(): Promise<void> {
        this.prompts.close();
        try {
            await this.drainPromise;
        } catch {
            // already logged in drain()
        }
        if (this.disposeSidePool) {
            try {
                await this.disposeSidePool();
            } catch {
                // best-effort
            }
        }
        this.emitter.removeAllListeners();
    }
}

