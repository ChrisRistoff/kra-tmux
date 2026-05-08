/**
 * SubAgentSession — runs a sub-agent task to completion in a fresh AgentSession.
 *
 * The sub-agent gets:
 *  - a restricted tool whitelist (enforced via onPreToolUse deny)
 *  - a `submit_result` local tool that captures its final structured output
 *  - a custom system prompt (replace mode)
 *
 * The loop terminates when the sub-agent stops calling tools (typical) or when
 * a hard tool-call cap is reached. The captured `submit_result` payload is
 * returned to the caller; if the sub-agent never called `submit_result`, the
 * result is `undefined`.
 *
 * Each invocation spins up its own MCP client pool — that is the cost of
 * isolation. A future optimisation could share pools across sessions.
 */

import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type {
    AgentConversationState,
    AgentPostToolUseHookInput,
    AgentPostToolUseHookOutput,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentSession,
    LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import type { SubAgentRuntime } from '@/AI/AIAgent/shared/subAgents/types';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
    appendToChat,
} from '@/AI/AIAgent/shared/utils/agentToolHook';
import { setupSessionEventHandlers } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { appendToAgentChatLayout } from '@/AI/AIAgent/shared/main/agentNeovimSetup';
import {
    formatAssistantHeader,
    formatSubAgentHeader,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';

/**
 * Bridge that wires a sub-agent into the orchestrator's chat / nvim UI.
 *
 * When supplied, the sub-agent's session events stream into the same chat
 * file (tagged with `agentLabel`), and every tool call goes through the
 * orchestrator's pre/post hooks so the user sees the same approval modal.
 * Bulk-approve memory is shared.
 */
export interface SubAgentChatBridge {
    /**
     * Function returning the parent (orchestrator) conversation state. Lazy
     * because the bridge is typically constructed before the orchestrator's
     * AgentConversationState exists. Resolved each time the sub-agent runs.
     */
    getParentState: () => AgentConversationState;
    agentLabel: string;
    /** Emoji used in the chat header (e.g. '🔍' for the investigator). */
    headerEmoji: string;
    parentOnPreToolUse: (input: AgentPreToolUseHookInput) => Promise<AgentPreToolUseHookOutput>;
    parentOnPostToolUse: (input: AgentPostToolUseHookInput) => Promise<AgentPostToolUseHookOutput | void>;
}

export interface SubAgentEvent {
    kind: 'tool_start' | 'tool_complete' | 'message' | 'reasoning';
    toolName?: string;
    success?: boolean;
    text?: string;
}

export interface SubAgentRunOptions {
    runtime: SubAgentRuntime;
    mcpServers: Record<string, MCPServerConfig>;
    workingDirectory: string;
    systemPrompt: string;
    taskPrompt: string;
    /** Tool names (namespaced, as exposed to the model) that the sub-agent may call. */
    toolWhitelist: string[];
    /** JSON Schema for the `submit_result` tool's arguments. */
    resultSchema: Record<string, unknown>;
    /**
     * Optional extra local tools the sub-agent may call (in addition to the
     * built-in `submit_result`). Names are merged into `allowedTools`. Use this
     * for callers that need to expose specialised in-process tools — for
     * example, the `investigate_web` sub-agent ships its `web_search`,
     * `web_scrape_and_index` and `research_query` tools as `LocalTool`s tagged
     * with the current `researchId` so they don't have to be wired through MCP.
     */
    additionalLocalTools?: LocalTool[];
    /** Optional event sink for streaming progress to the caller. */
    onEvent?: (e: SubAgentEvent) => void;
    /** Optional context window override for compaction. */
    contextWindow?: number;
    /**
     * Optional bridge into the orchestrator's UI. When set, sub-agent tool
     * calls flow through the orchestrator's approval modal (tagged with
     * `agentLabel`), and assistant text/reasoning/tool events stream into the
     * same chat file.
     */
    chatBridge?: SubAgentChatBridge;
    /**
     * Optional. Messages to inject after the system prompt.
     * Used for BYOK-only session continuation — the stored conversation
     * (sans system message) is passed here so the agent can resume. Ignored
     * when `existingHandle` is provided (session is already live with history).
     */
    initialMessages?: ChatCompletionMessageParam[];
    /**
     * Optional. Reuse a previously kept-alive sub-agent session
     */
    existingHandle?: SubAgentSessionHandle;
    /**
     * Optional. When true, do NOT call `session.disconnect()` after the turn.
     */
    keepAliveOnPause?: boolean;
}

/**
 * Mutable handle for a kept-alive sub-agent session. The submit_result tool
 * handler and the event-emit closure are bound at session-creation time but
 * reference these mutable slots so subsequent turns can rebind them without
 * re-registering tools or re-attaching listeners.
 */
export interface SubAgentSessionHandle {
    session: AgentSession;
    /** Per-turn capture target — reset before each `runSubAgentTask` call. */
    submitSlot: { captured?: Record<string, unknown>; resolveSubmitted?: () => void };
    /** Per-turn event sink — reset before each call so events route to the current run's array. */
    emitSlot: { current: (e: SubAgentEvent) => void };
    bridge?: SubAgentChatBridge;
    parentState?: AgentConversationState;
}

export interface SubAgentRunResult {
    /** Parsed JSON args from the sub-agent's `submit_result` call, if any. */
    result: Record<string, unknown> | undefined;
    /** Captured event log (post-hoc; for the orchestrator's audit trail). */
    events: SubAgentEvent[];
    /**
     * The session's full message array after execution.
     * Only populated when the sub-agent called submit_result AND the underlying
     * provider supports `getMessages()` (BYOK only). Prefer `liveHandle` for
     * cross-provider session continuation.
     */
    messages?: ChatCompletionMessageParam[];
    /**
     * Populated when `keepAliveOnPause` was true. Pass back as `existingHandle`
     * on the next `runSubAgentTask` call to continue the same session, or
     * dispose via `disposeSubAgentHandle` to release resources.
     */
    liveHandle?: SubAgentSessionHandle;
}

/**
 * Tear down a kept-alive sub-agent session. Best-effort — swallows errors
 * because cleanup is fire-and-forget.
 */
export async function disposeSubAgentHandle(handle: SubAgentSessionHandle): Promise<void> {
    if (handle.parentState && handle.parentState.activeSubAgentSession === handle.session) {
        handle.parentState.activeSubAgentSession = undefined;
    }
    try {
        await handle.session.disconnect();
    } catch {
        // disconnect is best-effort; nothing useful to do on failure.
    }
}

export async function runSubAgentTask(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
    const events: SubAgentEvent[] = [];
    const emit = (e: SubAgentEvent): void => {
        events.push(e);
        opts.onEvent?.(e);
    };

    let handle: SubAgentSessionHandle;
    let isReused: boolean;

    if (opts.existingHandle) {
        // ── Reuse path ───────────────────────────────────────────────────
        // Session is already live with full conversation history (tool calls
        // and tool results included). The submit_result tool was registered
        // at original creation; its handler closes over `submitSlot`, which
        // we reset below. Listeners and bridge wiring are preserved.
        handle = opts.existingHandle;
        isReused = true;

        if (handle.parentState) {
            handle.parentState.activeSubAgentSession = handle.session;
        }
    } else {
        // ── Fresh path ───────────────────────────────────────────────────
        const submitSlot: SubAgentSessionHandle['submitSlot'] = {};
        const emitSlot: SubAgentSessionHandle['emitSlot'] = { current: emit };

        const submitTool: LocalTool = {
            name: 'submit_result',
            description:
                'Submit your final structured result. Calling this signals the task is complete. ' +
                'After calling this, output a brief acknowledgement and STOP — do not call any further tools.',
            parameters: opts.resultSchema,
            serverLabel: 'kra-subagent',
            handler: async (args) => {
                submitSlot.captured = args;
                submitSlot.resolveSubmitted?.();

                return 'Result accepted. End your turn now without calling any more tools.';
            },
        };

        const bridge = opts.chatBridge;

        const onPreToolUse = async (input: AgentPreToolUseHookInput): Promise<AgentPreToolUseHookOutput> => {
            if (input.toolName === 'submit_result') {
                return { permissionDecision: 'allow' };
            }

            if (bridge) {
                return bridge.parentOnPreToolUse({
                    ...input,
                    agentLabel: bridge.agentLabel,
                });
            }

            return { permissionDecision: 'allow' };
        };

        const onPostToolUse = async (
            input: AgentPostToolUseHookInput
        ): Promise<AgentPostToolUseHookOutput | void> => {
            if (input.toolName === 'submit_result') {
                return;
            }

            if (bridge) {
                return bridge.parentOnPostToolUse({
                    ...input,
                    agentLabel: bridge.agentLabel,
                });
            }

            return;
        };

        const session: AgentSession = await opts.runtime.client.createSession({
            model: opts.runtime.model,
            workingDirectory: opts.workingDirectory,
            mcpServers: opts.mcpServers,
            localTools: [submitTool, ...(opts.additionalLocalTools ?? [])],
            systemMessage: { mode: 'replace', content: opts.systemPrompt },
            ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
            excludedTools: [
                'str_replace_editor', 'write_file', 'read_file', 'edit', 'view',
                'grep', 'glob', 'create', 'apply_patch', 'task',
                'bash', 'shell', 'run_in_terminal', 'execute', 'report_intent',
                // Sub-agents don't get raw web access. The web investigator
                // routes everything through `web_scrape_and_index` so pages
                // are chunked + indexed and the LLM only sees retrieved
                // excerpts. Other sub-agents have no business fetching pages.
                'web_fetch',
            ],
            ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
            allowedTools: [...opts.toolWhitelist, 'submit_result'],
            onPreToolUse,
            onPostToolUse,
            isSubAgent: true,
        });

        // Listeners read from emitSlot.current, so reused sessions route events
        // to the CURRENT run's array rather than the original run's (closed over).
        session.on('assistant.message_delta', (e) => {
            emitSlot.current({ kind: 'message', text: e.data.deltaContent });
        });
        session.on('tool.execution_start', (e) => {
            emitSlot.current({ kind: 'tool_start', toolName: e.data.toolName });
        });
        session.on('tool.execution_complete', (e) => {
            emitSlot.current({ kind: 'tool_complete', success: e.data.success });
        });

        const parentState = bridge?.getParentState();
        if (parentState) {
            parentState.activeSubAgentSession = session;
        }

        if (bridge && parentState) {
            await setupSessionEventHandlers(parentState, session, {
                agentLabel: bridge.agentLabel,
            });
        }

        handle = {
            session,
            submitSlot,
            emitSlot,
            ...(bridge ? { bridge } : {}),
            ...(parentState ? { parentState } : {}),
        };

        isReused = false;
    }

    // Per-turn rebinding: reset capture state and route events into THIS run.
    delete handle.submitSlot.captured;
    delete handle.submitSlot.resolveSubmitted;
    handle.emitSlot.current = emit;

    const submitted = new Promise<void>((resolve) => {
        handle.submitSlot.resolveSubmitted = resolve;
    });

    const session = handle.session;
    const bridge = handle.bridge;
    const parentState = handle.parentState;

    // Emit the sub-agent header for every turn (fresh OR resumed) so the chat
    // shows the executor handing off cleanly. On resume this acts as a visual
    // marker that the executor has picked the conversation back up.
    if (bridge && parentState) {
        const subAgentHeader = formatSubAgentHeader(bridge.headerEmoji, bridge.agentLabel, opts.runtime.model);
        await appendToChat(parentState.chatFile, subAgentHeader);
        appendToAgentChatLayout(parentState.nvim, subAgentHeader);
    }

    let finalMessages: ChatCompletionMessageParam[] | undefined;

    try {
        // Provider semantics differ: BYOK's send() blocks until the turn loop
        // ends, but the Copilot SDK's send() returns immediately after queuing
        // the prompt and the model runs asynchronously, with completion signalled
        // via the `session.idle` event. We wait for idle in both cases so the
        // sub-agent reliably finishes (and submit_result fires) before we
        // disconnect. We race against `submitted` (resolved by submit_result)
        // because some models keep emitting after submit, delaying `idle`.
        const idle = new Promise<void>((resolve) => {
            session.on('session.idle', () => resolve());
        });

        await session.send({ prompt: opts.taskPrompt });
        await Promise.race([idle, submitted]);
    } finally {
        if (bridge && parentState) {
            const assistantHeader = formatAssistantHeader(parentState.model);
            await appendToChat(parentState.chatFile, assistantHeader);
            appendToAgentChatLayout(parentState.nvim, assistantHeader);
        }

        if (opts.keepAliveOnPause) {
            // Skip disconnect; caller owns lifecycle via the returned liveHandle.
            // Leave activeSubAgentSession set so user-abort still tears it down.
        } else {
            if (parentState && parentState.activeSubAgentSession === session) {
                parentState.activeSubAgentSession = undefined;
            }

            // Capture messages BEFORE disconnect. The Copilot SDK's getMessages()
            // is an RPC into the session daemon; once disconnect() tears the
            // session down, the in-flight RPC rejects with `Session not found`.
            if (handle.submitSlot.captured) {
                try {
                    finalMessages = await session.getMessages?.();
                } catch {
                    finalMessages = undefined;
                }
            }

            try {
                await session.disconnect();
            } catch {
                // Disconnect is best-effort; never let cleanup errors mask the result.
            }
        }
    }

    const captured = handle.submitSlot.captured;
    const result: SubAgentRunResult = { result: captured, events };

    if (finalMessages) {
        result.messages = finalMessages;
    }
    if (opts.keepAliveOnPause) {
        result.liveHandle = handle;
    }

    // Suppress unused-variable warning for isReused — retained for future
    // diagnostics / logging hooks.
    void isReused;

    return result;
}

