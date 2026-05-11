/**
 * AgentHost — the abstraction that decouples the agent's
 * conversation/tool-hook/session-event modules from a concrete UI surface.
 *
 * Mirrors `chatHost.ts` (which the AIChat already uses) but extends it with
 * the agent-specific UI methods: turn lifecycle, tool lifecycle, user-input
 * prompt, executable tool list, error toast, proposal review, memory
 * browser, and the indexing-progress modal.
 *
 * The TUI implementation is built on top of an existing `ChatTuiApp`, so the
 * agent reuses every chat primitive verbatim — transcript pane, prompt
 * pane, status bar, approval modal, tool history, leader keys, popups.
 */

import type { ChatTuiApp } from '../chatTuiApp';
import type { ChatPickers } from './pickers';
import { createTuiChatHost, type ChatHost } from './chatHost';
import {
    type ToolApprovalPayload,
    type ToolApprovalDecision,
} from '../widgets/approvalModal';
import {
    showUserInputModal,
    type UserInputResponse,
} from '../widgets/userInputModal';
import {
    showIndexProgressModal,
    type IndexProgressModal,
} from '../widgets/indexProgressModal';
import {
    showMemoryBrowserModal,
    type MemoryView,
} from '../widgets/memoryBrowserModal';
import { showSessionHistoryModal } from '../widgets/sessionHistoryModal';
import type { AgentHistory } from '@/AI/AIAgent/shared/utils/agentHistory';
import { getAgentTurnHeaderRenderer } from '@/AI/AIAgent/shared/main/agentTurnHeaders';

export type AgentApprovalRequest = ToolApprovalPayload;
export type AgentApprovalDecision = ToolApprovalDecision;

export interface AgentIndexProgressApi {
    open: (title: string, lines?: string[]) => void;
    append: (line: string) => void;
    done: (summary?: string) => void;
    /** Re-open last index-progress modal (or notify last summary if finished). */
    reopen: () => void;
}

export interface AgentHost {
    // ─── transcript output ─────────────────────────────────────────────────
    /** Append a finalized line/block to the transcript (markdown-rendered). */
    appendLine: (text: string) => void;
    /** Feed a streaming markdown chunk into the transcript renderer. */
    appendChunk: (text: string) => void;
    /** Force-flush the streaming renderer (end-of-message). */
    flush: () => void;

    // ─── tool lifecycle ────────────────────────────────────────────────────
    requestApproval: (req: AgentApprovalRequest) => Promise<AgentApprovalDecision>;
    requestUserInput: (
        question: string,
        choices?: string[],
        allowFreeform?: boolean,
    ) => Promise<UserInputResponse>;
    recordToolStart: (entry: {
        toolName: string;
        summary: string;
        details?: string;
        argsJson: string;
        callId?: string;
    }) => void;
    recordToolUpdate: (entry: {
        toolName: string;
        summary?: string;
        details?: string;
        callId?: string;
    }) => void;
    recordToolComplete: (entry: {
        toolName: string;
        success: boolean;
        result: string;
        callId?: string;
    }) => void;

    // ─── session/turn UI state ─────────────────────────────────────────────
    startTurn: (model: string) => void;
    finishTurn: () => void;
    readyForNextPrompt: () => void;
    stopTurn: (message: string) => void;
    showError: (title: string, body: string) => void;
    setExecutableTools: (tools: unknown[]) => void;

    // ─── deferred features (chunks #2–#4) ──────────────────────────────────
    indexProgress: AgentIndexProgressApi;
    /** Open the kra-memory browser (NEW widget — chunk #3). */
    /** Open the kra-memory browser (NEW widget — chunk #3). */
    openMemoryBrowser: (view?: MemoryView) => Promise<void>;
    /** Open the per-write session file history (NEW widget — `<leader>s`). */
    openSessionHistory: (history: AgentHistory) => Promise<void>;
    pickMemories: (entries: unknown[], opts?: unknown) => Promise<unknown>;
    /** Open the proposal review widget (NEW widget — chunk #2). */
    showProposalReview: (diff: string) => Promise<void>;
    /** Display the result of a manually re-executed tool. */
    showToolExecutionResult: (
        result: string,
        error: string,
        title: string,
    ) => void;

    // ─── misc ──────────────────────────────────────────────────────────────
    /** Short-lived status-bar notification. */
    notify: (message: string, lingerMs?: number) => void;
    /** The underlying TUI app (for direct widget access where unavoidable). */
    app: ChatTuiApp;
}

export interface CreateTuiAgentHostOptions {
    app: ChatTuiApp;
    pickers: ChatPickers;
    /**
     * Optional pre-built ChatHost. When omitted, the agent builds one
     * from `app + pickers` using the same `createTuiChatHost` factory
     * the chat uses, guaranteeing identical streaming / approval /
     * tool-history behaviour without code duplication.
     */
    chatHost?: ChatHost;
}

export function createTuiAgentHost(opts: CreateTuiAgentHostOptions): AgentHost {
    const { app } = opts;
    // AgentHost composes the same ChatHost the chat uses so streaming,
    // approval modal, tool history, and finalized-line rendering stay in
    // lock-step between chat and agent. Only agent-specific surfaces
    // (user-input modal, index-progress popup, proposal review, memory
    // browser) are added here.
    const chatHost = opts.chatHost ?? createTuiChatHost({ app, pickers: opts.pickers });
    const getHeaderRenderer = (): { renderDraftBanner: () => void } => getAgentTurnHeaderRenderer(app);

    const notify = (message: string, lingerMs = 2000): void => {
        app.setStatus({ extra: message });
        if (lingerMs > 0) {
            setTimeout(() => app.setStatus({ extra: '' }), lingerMs);
        }
    };

    const stub = (label: string): void => {
        notify(`${label} — coming soon`, 2500);
    };

    let indexModal: IndexProgressModal | null = null;
    let indexLastTitle: string | null = null;
    const indexLastLines: string[] = [];
    let indexLastSummary: string | null = null;
    let indexFinished = false;

    return {
        // ——— transcript: delegate to ChatHost (zero duplication) ———
        appendLine: (text) => chatHost.appendChatLine(text),
        appendChunk: (text) => chatHost.appendChatChunk(text),
        flush: () => chatHost.flushChat(),
        // ——— approval modal: delegate to ChatHost ———
        requestApproval: async (req) => chatHost.requestApproval(req),
        requestUserInput: async (question, choices, allowFreeform) => {
            const modalOpts: Parameters<typeof showUserInputModal>[1] = {
                question,
                allowFreeform: allowFreeform ?? true,
            };
            if (choices && choices.length > 0) modalOpts.choices = choices;

            return showUserInputModal(app.screen, modalOpts);
        },
        // ——— tool history: delegate to ChatHost ———
        recordToolStart: (entry) => chatHost.recordToolStart(entry),
        recordToolUpdate: (entry) => chatHost.recordToolUpdate(entry),
        recordToolComplete: (entry) => chatHost.recordToolComplete(entry),
        startTurn: (_model) => {
            app.setStatus({ streaming: true, extra: '' });
        },
        finishTurn: () => {
            app.setStatus({ streaming: false });
        },
        readyForNextPrompt: () => {
            // Render the "USER (draft)" placeholder so the user knows the
            // assistant is done and the next turn is theirs (chat does the
            // same in `chatTui.ts:handleSubmit` finally block).
            getHeaderRenderer().renderDraftBanner();
            app.setStatus({ streaming: false, extra: 'ready' });
        },
        stopTurn: (message) => {
            app.setStatus({ streaming: false, extra: message });
        },
        showError: (title, body) => {
            const detail = body ? `${title}: ${body}` : title;
            notify(detail, 4000);
        },
        setExecutableTools: (_tools) => {
            // Chunk #4 will surface this in the tool-history filter; for
            // now it's recorded but not displayed.
        },
        indexProgress: {
            open: (title, lines) => {
                indexModal?.close();
                indexLastTitle = title;
                indexLastLines.length = 0;
                indexLastSummary = null;
                indexFinished = false;
                if (lines && lines.length > 0) indexLastLines.push(...lines);
                const modalOpts: Parameters<typeof showIndexProgressModal>[1] = { title };
                if (lines && lines.length > 0) modalOpts.initial = lines.join('\n');
                indexModal = showIndexProgressModal(app.screen, modalOpts);
            },
            append: (line) => {
                indexLastLines.push(line);
                if (!indexModal) return;
                indexModal.append(line);
            },
            done: (summary) => {
                indexLastSummary = summary ?? 'Indexing done';
                indexFinished = true;
                if (!indexModal) {
                    notify(indexLastSummary, 3000);

                    return;
                }
                const m = indexModal;
                indexModal = null;
                void m.finish(summary);
            },
            reopen: () => {
                if (indexModal) return;
                if (!indexLastTitle && indexLastLines.length === 0) {
                    notify('No indexing activity yet this session', 2500);

                    return;
                }
                const title = indexLastTitle ?? 'Index progress';
                const modalOpts: Parameters<typeof showIndexProgressModal>[1] = { title };
                if (indexLastLines.length > 0) modalOpts.initial = indexLastLines.join('\n');
                indexModal = showIndexProgressModal(app.screen, modalOpts);
                if (indexFinished && indexLastSummary) {
                    const m = indexModal;
                    indexModal = null;
                    void m.finish(indexLastSummary);
                }
            },
        },
        pickMemories: async (_entries, _opts) => {
            stub('Memory picker');

            return null;
        },
        openMemoryBrowser: async (view) => {
            await showMemoryBrowserModal(app.screen, {
                ...(view ? { initialView: view } : {}),
                notify,
            });
        },
        openSessionHistory: async (history) => {
            await showSessionHistoryModal(app.screen, { history, notify });
        },
        showProposalReview: async (_diff) => {
            stub('Proposal review');
        },
        showToolExecutionResult: (result, error, title) => {
            const msg = error
                ? `[${title}] error: ${error}`
                : `[${title}] ${result.split('\n')[0] ?? ''}`;
            notify(msg, 4000);
        },
        notify,
        app,
    };
}
