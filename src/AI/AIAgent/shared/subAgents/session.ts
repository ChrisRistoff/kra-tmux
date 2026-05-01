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
import {
    appendToChat,
} from '@/AI/AIAgent/shared/utils/agentToolHook';
import { setupSessionEventHandlers } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
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
}

export interface SubAgentRunResult {
    /** Parsed JSON args from the sub-agent's `submit_result` call, if any. */
    result: Record<string, unknown> | undefined;
    /** Captured event log (post-hoc; for the orchestrator's audit trail). */
    events: SubAgentEvent[];
}

export async function runSubAgentTask(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
    const events: SubAgentEvent[] = [];
    const emit = (e: SubAgentEvent): void => {
        events.push(e);
        opts.onEvent?.(e);
    };

    let captured: Record<string, unknown> | undefined;

    const submitTool: LocalTool = {
        name: 'submit_result',
        description:
            'Submit your final structured result. Calling this signals the task is complete. ' +
            'After calling this, output a brief acknowledgement and STOP — do not call any further tools.',
        parameters: opts.resultSchema,
        serverLabel: 'kra-subagent',
        handler: async (args) => {
            captured = args;

            return 'Result accepted. End your turn now without calling any more tools.';
        },
    };

    const whitelist = new Set([...opts.toolWhitelist, 'submit_result']);
    const bridge = opts.chatBridge;

    const matchesWhitelist = (toolName: string): boolean => {
        if (whitelist.has(toolName)) {
            return true;
        }

        // Different providers prefix MCP tools differently:
        //   BYOK   → bare `originalName` (e.g. `read_lines`)
        //   Copilot → `<server>__<tool>` or `<server>-<tool>` (e.g. `kra-memory-search`)
        // Match if any whitelist entry appears as a trailing segment delimited
        // by `__`, `-` or `.`. We deliberately do NOT split on `_` because
        // many tool names (read_lines, lsp_query, …) contain underscores.
        for (const allowed of whitelist) {
            const re = new RegExp(`(^|[\\-.]|__)${allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

            if (re.test(toolName)) {
                return true;
            }
        }

        return false;
    };

    const onPreToolUse = async (input: AgentPreToolUseHookInput): Promise<AgentPreToolUseHookOutput> => {
        if (!matchesWhitelist(input.toolName)) {
            return {
                permissionDecision: 'deny',
                permissionDecisionReason:
                    `Tool '${input.toolName}' is not in this sub-agent's whitelist. ` +
                    `Allowed tools: ${[...whitelist].join(', ')}.`,
            };
        }

        // submit_result is synthetic — don't bother the user for approval.
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
        localTools: [submitTool],
        systemMessage: { mode: 'replace', content: opts.systemPrompt },
        ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
        excludedTools: [
            'str_replace_editor', 'write_file', 'read_file', 'edit', 'view',
            'grep', 'glob', 'create', 'apply_patch',
            'bash', 'shell', 'run_in_terminal', 'execute',
        ],
        onPreToolUse,
        onPostToolUse,
    });

    // Always capture into the local event log for the caller's audit trail.
    session.on('assistant.message_delta', (e) => {
        emit({ kind: 'message', text: e.data.deltaContent });
    });
    session.on('tool.execution_start', (e) => {
        emit({ kind: 'tool_start', toolName: e.data.toolName });
    });
    session.on('tool.execution_complete', (e) => {
        emit({ kind: 'tool_complete', success: e.data.success });
    });

    // Track this session on the parent state so the user's `stop_stream`
    // action can also abort the sub-agent (otherwise hitting stop only stops
    // the orchestrator and the sub-agent keeps running tools).
    const parentState = bridge?.getParentState();

    if (parentState) {
        parentState.activeSubAgentSession = session;
    }

    // If bridged, mirror the session into the orchestrator's chat/nvim UI.
    if (bridge && parentState) {
        await setupSessionEventHandlers(parentState, session, {
            agentLabel: bridge.agentLabel,
        });
        await appendToChat(
            parentState.chatFile,
            formatSubAgentHeader(bridge.headerEmoji, bridge.agentLabel, opts.runtime.model)
        );
    }

    try {
        // Provider semantics differ: BYOK's send() blocks until the turn loop
        // ends, but the Copilot SDK's send() returns immediately after queuing
        // the prompt and the model runs asynchronously, with completion signalled
        // via the `session.idle` event. We wait for idle in both cases so the
        // sub-agent reliably finishes (and submit_result fires) before we
        // disconnect.
        const idle = new Promise<void>((resolve) => {
            session.on('session.idle', () => resolve());
        });

        await session.send({ prompt: opts.taskPrompt });
        await idle;
    } finally {
        if (bridge && parentState) {
            await appendToChat(
                parentState.chatFile,
                formatAssistantHeader(parentState.model)
            );
        }
        if (parentState && parentState.activeSubAgentSession === session) {
            parentState.activeSubAgentSession = undefined;
        }
        await session.disconnect();
    }

    return { result: captured, events };
}
