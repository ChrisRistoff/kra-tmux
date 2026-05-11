/**
 * ChatHost — the abstraction that decouples promptModel / chatToolApproval
 * from a concrete UI surface. Wired to a blessed TUI.
 */

import type { ChatTuiApp } from '../chatTuiApp';
import type { ChatPickers } from './pickers';
import { showApprovalModal, type ToolApprovalPayload, type ToolApprovalDecision } from '../widgets/approvalModal';

// The chat side now passes a fully-built ToolApprovalPayload (rich payload
// with details / argsJson / summary). Reusing the modal's types keeps the
// future agent migration trivial — just point its hook at this same host.
export type ChatApprovalRequest = ToolApprovalPayload;
export type ChatApprovalDecision = ToolApprovalDecision;

export interface ChatHost {
    /** Append a finalized line (or multi-line block) to the transcript. */
    appendChatLine: (text: string) => void;
    /** Feed a streaming markdown chunk into the transcript renderer. */
    appendChatChunk: (text: string) => void;
    /** Force-flush the streaming renderer (end-of-message). */
    flushChat: () => void;
    /** Show the tool-approval modal and resolve with the user's decision. */
    requestApproval: (req: ChatApprovalRequest) => Promise<ChatApprovalDecision>;
    /** Push a tool-call lifecycle event into the in-memory history log. */
    recordToolStart: (entry: { toolName: string, summary: string, details?: string, argsJson: string, callId?: string }) => void;
    recordToolUpdate: (entry: { toolName: string, summary?: string, details?: string, callId?: string }) => void;
    recordToolComplete: (entry: { toolName: string, success: boolean, result: string, callId?: string }) => void;
    /**
     * Surface a tool-lifecycle event in the TUI. The implementation paints
     * a small status line; `complete_tool` also appends a tool-result
     * marker into the transcript.
     */
    updateToolUi: (method: 'start_tool' | 'complete_tool', args: unknown[]) => Promise<void>;
}

export interface CreateTuiChatHostOptions {
    app: ChatTuiApp;
    pickers: ChatPickers;
}

export function createTuiChatHost(opts: CreateTuiChatHostOptions): ChatHost {
    const { app } = opts;

    return {
        appendChatLine: (text) => {
            if (!text) return;
            // Route through the markdown renderer so headers (e.g. the
            // `### 👤 USER · ts` separators emitted by chatHeaders) and any
            // inline markdown the user typed get the same styled rendering
            // as streamed assistant chunks. flushMarkdown commits whatever
            // partial tail the renderer is holding so the line lands
            // immediately rather than waiting for the next chunk.
            const block = text.endsWith('\n') ? text : text + '\n';
            app.appendMarkdown(block);
            app.flushMarkdown();
        },
        appendChatChunk: (text) => {
            if (!text) return;
            app.appendMarkdown(text);
        },
        flushChat: () => {
            app.flushMarkdown();
        },
        requestApproval: async (req) => {
            return showApprovalModal(app.screen, req);
        },
        recordToolStart: (entry) => {
            app.toolHistory.start(entry);
            app.spinner.start(entry);
        },
        recordToolUpdate: (entry) => {
            app.spinner.update(entry);
        },
        recordToolComplete: (entry) => {
            app.toolHistory.complete(entry);
            app.spinner.complete(entry);
        },
        updateToolUi: async (method, args) => {
            try {
                if (method === 'start_tool') {
                    const summary = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
                    app.setStatus({ extra: `tool: ${summary}` });
                } else if (method === 'complete_tool') {
                    const ok = args[2] === true;
                    const summary = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
                    app.setStatus({ extra: ok ? `done: ${summary}` : `failed: ${summary}` });
                }
            } catch {
                /* best-effort UI update */
            }
        },
    };
}
