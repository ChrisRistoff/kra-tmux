/**
 * Shared transcript-header rendering for AIChat and AIAgent.
 *
 * Both surfaces show the same `### 👤 USER PROMPT` / `### 🤖 ASSISTANT` h3
 * banners around each turn, plus a "USER (draft)" placeholder after the
 * assistant finishes so the user knows the next turn is theirs. This module
 * is the single source of truth for that flow — any visual / behavioural
 * change must happen here so chat and agent stay in lock-step.
 */

import type { ChatTuiApp } from '@/AI/TUI/chatTuiApp';
import {
    formatAssistantHeader,
    formatUserDraftHeader,
    formatUserHeader,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';

export interface TurnHeaderRenderer {
    /**
     * Render the user-prompt header + body. Clears any draft banner /
     * attachments block from the previous turn first so the new header
     * doesn't pile on top.
     */
    renderUserHeader: (prompt: string, timestamp: string) => void;
    /** Render the assistant header (called right before streaming starts). */
    renderAssistantHeader: (model: string, timestamp: string) => void;
    /**
     * Render the "USER (draft)" placeholder + the current attachment
     * list right under it. Both live in a single anchored block so we
     * can re-render in place when attachments change.
     */
    renderDraftBanner: () => void;
    /**
     * Replace the current attachment list shown under the draft banner
     * with `items` and re-render the block in place. Pass [] to clear.
     */
    setAttachments: (items: string[]) => void;
    /** Drop the captured anchor without writing. (Used on shutdown / reset.) */
    clearDraftAnchor: () => void;
}

export function createTurnHeaderRenderer(app: ChatTuiApp): TurnHeaderRenderer {
    // Anchor for the combined "draft + attachments" block. When set,
    // everything from `draftBannerAnchor` to the end of the transcript is
    // owned by this renderer and will be rewound on the next render.
    let draftBannerAnchor: number | null = null;
    let attachments: string[] = [];

    const flushAndReset = (): void => {
        app.flushMarkdown();
        app.resetMarkdown();
    };

    const rewindDraftBlock = (): void => {
        if (draftBannerAnchor === null) return;
        const drop = app.transcript.lineCount() - draftBannerAnchor;
        if (drop > 0) app.transcript.replaceLastLines(drop, []);
        draftBannerAnchor = null;
    };

    const writeDraftBlock = (): void => {
        draftBannerAnchor = app.transcript.lineCount();
        app.appendMarkdown(formatUserDraftHeader());
        if (attachments.length > 0) {
            const list = attachments.map((a) => `* ${a}`).join('\n');
            app.appendMarkdown(`\n**Attachments:**\n${list}\n`);
        }
        flushAndReset();
    };

    return {
        renderUserHeader: (prompt, timestamp) => {
            rewindDraftBlock();
            attachments = [];
            app.appendMarkdown(`${formatUserHeader(timestamp)}${prompt}\n`);
            flushAndReset();
        },
        renderAssistantHeader: (model, timestamp) => {
            app.appendMarkdown(formatAssistantHeader(model, timestamp));
            flushAndReset();
        },
        renderDraftBanner: () => {
            rewindDraftBlock();
            writeDraftBlock();
        },
        setAttachments: (items) => {
            attachments = items.slice();
            // If we're already inside a draft block, re-render it; if not
            // (e.g. mid-stream), just store — the next renderDraftBanner
            // will pick the new list up.
            if (draftBannerAnchor !== null) {
                rewindDraftBlock();
                writeDraftBlock();
            }
        },
        clearDraftAnchor: () => {
            draftBannerAnchor = null;
        },
    };
}
