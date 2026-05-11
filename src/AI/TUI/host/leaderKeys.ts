/**
 * Shared leader-key wiring used by BOTH AIChat (`runChatTui`) and AIAgent
 * (`converseAgent`). Previously each surface had its own
 * `wireXxxLeaderKeys` function and rebuilt the same six leader items
 * (a/r/f/x/h/t) inline — this module is the single source of truth for
 * those items. Surfaces extend it by passing `extraItems`.
 *
 * Why centralise:
 *  - Adding a new shared leader item only has to happen in one file.
 *  - Behaviour stays identical between chat and agent (same key labels,
 *    same descriptions, same modal title styling, same focus-suppression
 *    when the prompt is in INSERT mode).
 */

import type { ChatTuiApp } from '@/AI/TUI/chatTuiApp';
import type { ChatPickers } from './pickers';
import type { ChatHost } from './chatHost';
import {
    runFileContextAdd,
    runFileContextClear,
    runFileContextRemove,
    runFileContextShow,
} from '@/AI/TUI/host/fileContextTui';
import { showToolHistoryPanel } from '@/AI/TUI/widgets/toolHistoryPanel';
import { showWhichKey, isLeaderOpen, type WhichKeyItem } from '@/AI/TUI/widgets/whichKeyModal';
import { pushActiveInputPane, topActiveInputPane } from '@/AI/TUI/state/activeInputPane';

export interface SharedLeaderOptions {
    app: ChatTuiApp;
    pickers: ChatPickers;
    chatHost: ChatHost;
    chatFile: string;
    /** Window title shown in the which-key modal banner. */
    title?: string;
    /** Additional items appended to the shared core items. */
    extraItems?: WhichKeyItem[];
    /** Optional Ctrl-C handler (chat uses this to stop streaming). */
    onCtrlC?: () => void;
    /**
     * Fired after any file-context add/remove/clear so the surface can
     * refresh its "Attachments" listing under the USER (draft) banner.
     */
    onContextsChanged?: () => void;
}

/**
 * Build the set of leader items that are common to chat and agent.
 * Surfaces append their own items (proposal review, memory browser,
 * indexing, YOLO, etc.) and pass them through `extraItems`.
 */
export function buildSharedLeaderItems(opts: SharedLeaderOptions): WhichKeyItem[] {
    const { app, pickers, chatHost, chatFile } = opts;

    return [
        { key: 'a', category: 'Context', label: 'Add context',    description: 'Pick a file to attach to the prompt',
          action: () => { void runFileContextAdd(chatFile, pickers, chatHost).then(() => opts.onContextsChanged?.()); } },
        { key: 'r', category: 'Context', label: 'Remove context', description: 'Detach a file from the prompt',
          action: () => { void runFileContextRemove(chatFile, pickers, chatHost).then(() => opts.onContextsChanged?.()); } },
        { key: 'f', category: 'Context', label: 'Show contexts',  description: 'Inspect attached files',
          action: () => { void runFileContextShow(pickers); } },
        { key: 'x', category: 'Context', label: 'Clear contexts', description: 'Detach all files',
          action: () => { void runFileContextClear(chatFile, pickers, chatHost).then(() => opts.onContextsChanged?.()); } },
        { key: 'h', category: 'Inspect', label: 'Tool history',   description: 'Browse recent tool calls + results',
          action: () => { void showToolHistoryPanel(app.screen, app.toolHistory); } },
        { key: 't', category: 'View',
          label: app.popups.isHidden() ? 'Show popups' : 'Hide popups',
          description: 'Toggle visibility of every overlay (modals, spinner, history, …)',
          action: () => app.popups.toggle() },
    ];
}

export function wireSharedLeaderKeys(opts: SharedLeaderOptions): void {
    const { app, title } = opts;
    const { screen, prompt } = app;

    const openLeader = (): void => {
        if (isLeaderOpen()) return;
        const items = [
            ...buildSharedLeaderItems(opts),
            ...(opts.extraItems ?? []),
        ];
        void showWhichKey(screen, items, { title: title ?? 'Leader (␣)' });
    };

    // Register the main prompt as the bottom of the active-input stack.
    // Modals (e.g. freeformInputModal) will push themselves on top while
    // open so the leader handler always queries the topmost input.
    pushActiveInputPane({ el: prompt.el, isInsert: () => prompt.mode() === 'INSERT' });

    screen.key('space', () => {
        const top = topActiveInputPane();
        if (top && screen.focused === top.el) {
            if (top.isInsert()) return;
            if (top.openLeader) {
                // Pane defines its own which-key bindings — delegate.
                top.openLeader();

                return;
            }
        }
        openLeader();
    });

    if (opts.onCtrlC) {
        screen.key('C-c', opts.onCtrlC);
    }
}
