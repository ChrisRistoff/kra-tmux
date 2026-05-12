import type { AgentHost } from '@/AI/TUI/host/agentHost';
import {
    formatToolArguments,
    formatToolCompletion,
    formatToolDisplayName,
    formatToolLine,
    formatToolProgress,
    summarizeToolCall,
} from '@/AI/AIAgent/shared/utils/agentUi';
import { formatUserDraftHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';
// agentNeovimSetup helpers (focusAgentPrompt, refreshAgentLayout,
// appendToAgentChatLayout) are no longer used here — the TUI host owns
// transcript writes and prompt focus.
import { appendToChat } from '@/AI/AIAgent/shared/utils/agentToolHook';
import type { AgentConversationState, AgentSession } from '@/AI/AIAgent/shared/types/agentTypes';
import { setupQuotaTracking } from '@/AI/AIAgent/shared/utils/agentQuotaTracker';
import { loadSettings } from '@/utils/common';
import { computeDrainCount, resolvePacerConfig } from '@/AI/shared/streamPacer';



/**
 * Dispatch a UI lifecycle call to the active `AgentHost` (the blessed TUI).
 */
export async function updateAgentUi(
    host: AgentHost,
    method: string,
    args: unknown[] = []
): Promise<void> {
    try {
        dispatchHostUi(host, method, args);
    } catch {
        // Ignore UI update failures during startup/shutdown so the session itself can continue.
    }

    return Promise.resolve();
}


function dispatchHostUi(host: AgentHost, method: string, args: unknown[]): void {
    switch (method) {
        case 'start_turn':
            host.startTurn(typeof args[0] === 'string' ? args[0] : '');

            return;
        case 'finish_turn':
            host.finishTurn();

            return;
        case 'ready_for_next_prompt':
            host.readyForNextPrompt();

            return;
        case 'stop_turn':
            host.stopTurn(typeof args[0] === 'string' ? args[0] : 'stopped');

            return;
        case 'show_error':
            host.showError(
                typeof args[0] === 'string' ? args[0] : 'Error',
                typeof args[1] === 'string' ? args[1] : '',
            );

            return;
        case 'set_executable_tools':
            host.setExecutableTools(Array.isArray(args[0]) ? (args[0] as unknown[]) : []);

            return;
        case 'show_tool_execution_result':
            host.showToolExecutionResult(
                typeof args[0] === 'string' ? args[0] : '',
                typeof args[1] === 'string' ? args[1] : '',
                typeof args[2] === 'string' ? args[2] : '',
            );

            return;
        case 'start_tool': {
            const toolName = typeof args[0] === 'string' ? args[0] : 'tool';
            const details = typeof args[1] === 'string' ? args[1] : '';
            const argsJson = typeof args[2] === 'string' ? args[2] : '{}';
            const callId = typeof args[3] === 'string' ? args[3] : undefined;
            host.recordToolStart({
                toolName,
                summary: details.split('\n')[0] ?? toolName,
                details,
                argsJson,
                ...(callId ? { callId } : {}),
            });

            return;
        }
        case 'update_tool': {
            // Streaming progress for an in-flight tool. Refresh the
            // top-right indicator with the latest details so the user
            // can see what the tool is currently doing.
            const toolName = typeof args[0] === 'string' ? args[0] : 'tool';
            const details = typeof args[1] === 'string' ? args[1] : '';
            const callId = typeof args[2] === 'string' ? args[2] : undefined;
            host.recordToolUpdate({
                toolName,
                summary: details.split('\n')[0] ?? toolName,
                details,
                ...(callId ? { callId } : {}),
            });

            return;
        }
        case 'complete_tool': {
            const toolName = typeof args[0] === 'string' ? args[0] : 'tool';
            const success = args[2] === true;
            const fullResult = typeof args[3] === 'string' ? args[3] : '';
            const callId = typeof args[4] === 'string' ? args[4] : undefined;
            host.recordToolComplete({ toolName, success, result: fullResult, ...(callId ? { callId } : {}) });

            return;
        }
        case 'show_index_progress_modal': {
            const payload = (args[0] ?? {}) as { alias?: string; total_files?: number; mode?: string };
            const title = payload.alias
                ? `Indexing ${payload.alias}${payload.total_files ? ` (${payload.total_files} files)` : ''}`
                : 'Indexing';
            host.indexProgress.open(title);

            return;
        }
        case 'append_index_progress': {
            const payload = (args[0] ?? {}) as { line?: string };
            host.indexProgress.append(payload.line ?? '');

            return;
        }
        case 'set_index_progress_done': {
            const payload = (args[0] ?? {}) as { summary?: string };
            host.indexProgress.done(payload.summary);

            return;
        }
        default:
            // Unknown UI method — surface it as a notify so we notice during the port.
            host.notify(`ui:${method}`, 1500);
    }
}


export interface SessionEventHandlerOptions {
    /**
     * Optional label identifying which agent owns this session. When set,
     * chat writes and the nvim modal entries are tagged with `[<agentLabel>]`,
     * and the idle handler skips the "ready for next prompt" routine (the
     * sub-agent's caller writes its own footer and returns control to the
     * orchestrator).
     */
    agentLabel?: string;
    /**
     * Sub-agent only. Called from inside the `session.idle` handler
     * AFTER `flushBuffer(true)` and `await writeChain` have settled, so
     * the caller can guarantee the sub-agent's pending tokens are
     * flushed to the transcript before it splices in the next header.
     * Without this, the orchestrator's assistant header can arrive
     * before the sub-agent's tail bytes drain, producing duplicated
     * ("bleeding") characters under the next entry.
     */
    onDrained?: () => void;
}

export async function setupSessionEventHandlers(
    state: AgentConversationState,
    session: AgentSession = state.session,
    opts: SessionEventHandlerOptions = {}
): Promise<void> {
    // Smoothness pacer cadence. Defaults produce a 1-by-1 typewriter at
    // ~250 chars/sec; bursts catch up via proportional drain so we never
    // fall behind the model. See `[ai.chatInterface]` in settings.toml.example.
    const iface = (await loadSettings()).ai?.chatInterface;
    const pacerCfg = resolvePacerConfig(iface);
    const agentLabel = opts.agentLabel;
    const labelTag = agentLabel ? `[${agentLabel}] ` : '';
    const isSubAgent = agentLabel !== undefined;

    let pendingBuffer = '';
    let activeToolCount = 0;
    let currentToolLabel = 'tool';
    let assistantStatusVisible = true;
    let firstToolThisTurn = true;
    let reasoningStarted = false;

    // Close the ```thinking fence opened by reasoning_delta. Safe to call
    // unconditionally; no-op when no reasoning is in flight.
    const closeReasoningFence = (): void => {
        if (!reasoningStarted) return;
        reasoningStarted = false;
        // Write to the live transcript SYNCHRONOUSLY so any caller (e.g.
        // the ask_kra preToolUse hook) that follows up with `appendLine`
        // sees its content rendered AFTER the fence-close, not before it.
        // The chat-file write stays on the writeChain queue to preserve
        // ordering relative to other deltas.
        state.host.appendChunk('\n```\n\n');
        enqueue(async () => {
            await appendToChat(state.chatFile, '\n```\n\n');
        });
    };
    // Expose to hooks (e.g. ask_kra in agentToolHook) that need to flush
    // any open reasoning fence before writing top-level transcript entries.
    state.closeReasoningFence = closeReasoningFence;

    // Expose a force-drain so hooks that show a blocking modal (tool
    // approval, ask_kra) can catch the transcript up to the model's
    // current position before pausing the turn. Without this the model
    // keeps streaming into `pendingBuffer` while the modal is up and
    // the user only sees that prose AFTER answering — which makes the
    // modal feel like it appeared mid-sentence.
    state.flushPendingProse = async (): Promise<void> => {
        clearFlushTimer();
        while (pendingBuffer) flushBuffer(true);
        await writeChain;
    };
    const toolLabels = new Map<string, string>();
    const toolStartLabels = new Map<string, string>();

    let writeChain = Promise.resolve();

    const enqueue = (fn: () => Promise<void>): void => {
        writeChain = writeChain.then(fn).catch(() => { /* swallow */ });
    };

    // Hot-path streaming append: write the same `content` to the chat file on
    // disk AND push it directly into the transcript pane via the host. The
    // chat-file write keeps `saveChat` round-tripping identical to the legacy
    // path; the host call drives the live UI.
    const nvimAppend = (content: string): void => {
        state.host.appendChunk(content);
    };

    const write = (content: string, refresh = true): void => {
        enqueue(async () => {
            await appendToChat(state.chatFile, content);
            if (refresh) {
                nvimAppend(content);
            }
        });
    };

    let needsBlockquotePrefix = true;

    // `force=true` drains everything (used at end-of-turn so the user
    // doesn't watch the tail typewriter-trickle after the model is done).
    const flushBuffer = (force = false): void => {
        if (!pendingBuffer) {
            return;
        }

        const drainCount = computeDrainCount(pendingBuffer.length, pacerCfg, force);
        const text = pendingBuffer.slice(0, drainCount);
        pendingBuffer = pendingBuffer.slice(drainCount);
        if (isSubAgent) {
            // Sub-agent output renders as a markdown blockquote so it stays
            // visually grouped under the sub-agent header. Each line in the
            // chat file needs `> `, but the prefix must only be written at
            // the start of a new line — not on every streaming chunk — or
            // chunks that arrive mid-line produce `text>  more text` artifacts.
            const indented = text.replace(/\n/g, '\n> ');
            const prefix = needsBlockquotePrefix ? '> ' : '';
            write(`${prefix}${indented}`);
            needsBlockquotePrefix = text.endsWith('\n');
        } else {
            write(text);
        }
    };

    // Pacer drains a fraction of pendingBuffer each tick. Self-scheduling
    // setTimeout so the timer goes fully dormant when there's nothing to
    // flush (avoids keeping the event loop hot between turns).
    let flushTimerHandle: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = (): void => {
        if (flushTimerHandle !== null) return;
        flushTimerHandle = setTimeout(() => {
            flushTimerHandle = null;
            if (pendingBuffer && activeToolCount === 0) {
                flushBuffer(false);
            }
            if (pendingBuffer) {
                scheduleFlush();
            }
        }, pacerCfg.intervalMs);
    };

    const clearFlushTimer = (): void => {
        if (flushTimerHandle !== null) {
            clearTimeout(flushTimerHandle);
            flushTimerHandle = null;
        }
    };

    // ============================================================================
    // REASONING & CONTENT STREAMING
    // ============================================================================

    // Reasoning is rendered through the SAME pipeline the chat uses:
    // wrap deltas in a ```thinking fenced block so the shared markdown
    // streamRenderer styles them with the cyan side-bar and italic
    // blue prose. Previously the agent emitted `> 💭` blockquotes which
    // bypassed that styling and made the agent look different.
    session.on('assistant.reasoning_delta', (event) => {
        const isFirst = !reasoningStarted;
        reasoningStarted = true;
        enqueue(async () => {
            const opener = isFirst ? `\n\`\`\`thinking\n` : '';
            const chunk = `${opener}${event.data.deltaContent}`;
            await appendToChat(state.chatFile, chunk);
            nvimAppend(chunk);
        });
    });


    session.on('assistant.message_delta', (event) => {
        closeReasoningFence();

        pendingBuffer += event.data.deltaContent;
        scheduleFlush();

        if (!isSubAgent && activeToolCount === 0 && !assistantStatusVisible) {
            assistantStatusVisible = true;
            void updateAgentUi(state.host, 'start_turn', [state.model]);
        }
    });

    // ============================================================================
    // TOOL EXECUTION HANDLERS
    // ============================================================================

    session.on('tool.execution_start', (event) => {
        closeReasoningFence();
        activeToolCount += 1;
        const rawName = formatToolDisplayName(
            event.data.toolName,
            event.data.mcpServerName,
            event.data.mcpToolName
        );
        const toolName = `${labelTag}${rawName}`;
        currentToolLabel = toolName;
        assistantStatusVisible = false;
        toolLabels.set(event.data.toolCallId, toolName);
        toolStartLabels.set(event.data.toolCallId, summarizeToolCall(toolName, event.data.arguments));

        if (firstToolThisTurn) {
            firstToolThisTurn = false;
            flushBuffer();
        }

        const details = `Running ${toolName}\n\nArguments:\n${formatToolArguments(event.data.arguments)}`;
        const argsJson = JSON.stringify(event.data.arguments ?? {}, null, 2);
        void updateAgentUi(state.host, 'start_tool', [toolName, details, argsJson, event.data.toolCallId]);
    });

    session.on('tool.execution_progress', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const details = `Running tool\n\n${formatToolProgress(event.data.progressMessage)}`;
        void updateAgentUi(state.host, 'update_tool', [currentToolLabel, details, event.data.toolCallId]);
    });

    session.on('tool.execution_partial_result', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const details = `Streaming tool output\n\n${formatToolProgress(event.data.partialOutput)}`;
        void updateAgentUi(state.host, 'update_tool', [currentToolLabel, details, event.data.toolCallId]);
    });

    session.on('tool.execution_complete', (event) => {
        activeToolCount = Math.max(0, activeToolCount - 1);
        const toolName = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const toolSummary = toolStartLabels.get(event.data.toolCallId) ?? toolName;
        toolLabels.delete(event.data.toolCallId);
        toolStartLabels.delete(event.data.toolCallId);
        currentToolLabel = toolName;
        assistantStatusVisible = activeToolCount === 0;

        if (activeToolCount === 0) {
            firstToolThisTurn = true;
            closeReasoningFence();
        }

        write(formatToolLine(toolSummary, event.data.success));

        const details = formatToolCompletion(event.data.success, event.data.result, event.data.error);
        const fullResult = event.data.success
            ? (event.data.result?.detailedContent ?? event.data.result?.content ?? '')
            : (event.data.error ? String(event.data.error) : '');
        void updateAgentUi(state.host, 'complete_tool', [
            toolName,
            details,
            event.data.success,
            fullResult,
            event.data.toolCallId,
        ]);

    });

    // ============================================================================
    // SESSION STATE
    // ============================================================================

    session.on('session.idle', () => {
        void (async () => {
            closeReasoningFence();
            clearFlushTimer();
            // Force-drain the remaining buffer so the user doesn't watch a
            // typewriter tail after the model has already finished.
            flushBuffer(true);

            await writeChain;

            activeToolCount = 0;
            assistantStatusVisible = false;

            if (isSubAgent) {
                // Signal the orchestrator that the sub-agent's pending
                // buffer + writeChain have fully drained, so it's safe
                // to emit the next role header without bleeding.
                try { opts.onDrained?.(); } catch { /* never let the hook break idle */ }

                // Sub-agent finished its run; orchestrator owns the prompt UI.
                return;
            }

            state.isStreaming = false;

            await appendToChat(state.chatFile, formatUserDraftHeader());
            await updateAgentUi(state.host, 'ready_for_next_prompt');

        })();
    });

    if (!isSubAgent) {
        setupQuotaTracking(state);
    }
}
