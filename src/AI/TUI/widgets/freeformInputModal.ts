/**
 * Shared multi-line freeform input modal used by:
 *   - `userInputModal` (the agent's "Custom answer" popup, also used
 *     for `ask_kra`).
 *   - `approvalModal` (the "Deny reason" popup when a tool call is
 *     denied via `d`).
 *
 * Mounts a real `promptPane` inside a popup box so the user gets the
 * SAME modal editing experience as the main prompt pane:
 *   - NORMAL / INSERT modes (vim-style)
 *   - Enter in INSERT inserts a newline
 *   - Enter in NORMAL submits
 *   - Esc / C-c cancels (resolves with null)
 *
 * The modal is intentionally sized larger than the previous
 * single-line `blessed.textbox` so longer free-text answers are
 * comfortable to type.
 */

import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { pauseScreenKeys } from '@/UI/dashboard/screen';
import { createPromptPane, type PromptMode } from './promptPane';
import { pushActiveInputPane } from '../state/activeInputPane';
import { BG_PRIMARY, BG_PANEL } from '../theme';

export interface FreeformInputOptions {
    /** Top label shown on the popup border. */
    title: string;
    /** Border colour (defaults to cyan). */
    borderFg?: string;
    /** Initial buffer text (defaults to empty). */
    initial?: string;
    /** Override the bottom hint line. */
    hint?: string;
    /** highlight.js language id passed through to the inner promptPane
     *  for live syntax-coloured editing. */
    syntaxLanguage?: string;
    /** When true (default) an empty submission is treated as cancel
     *  (resolves null). Set false to allow empty submissions — used
     *  by the deny-reason flow so submitting an empty buffer means
     *  "deny with the default message". */
    emptyAsCancel?: boolean;
}

export async function showFreeformInputModal(
    screen: blessed.Widgets.Screen,
    opts: FreeformInputOptions,
): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        const savedFocus = screen.focused;
        // While this modal is up, swallow the screen-level leader/quit
        // keys so they don't fire under the popup.
        const restoreKeys = pauseScreenKeys(
            screen,
            ['escape', 'q', 'C-c', 'C-q', 'enter'],
        );

        const screenH = (screen.height as number) || 24;
        const height = Math.min(Math.max(12, Math.floor(screenH * 0.45)), screenH - 4);

        const box = blessed.box({
            parent: screen,
            label: ` ${opts.title} `,
            top: 'center',
            left: 'center',
            width: '80%',
            height,
            border: { type: 'line' },
            style: { border: { fg: opts.borderFg ?? 'cyan' }, bg: BG_PRIMARY },
            tags: true,
            keys: false,
            mouse: false,
        });
        const overlay = markOverlay(box);
        box.setFront();

        // Bottom hint line.
        const hint = blessed.box({
            parent: box,
            bottom: 0,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            style: { bg: BG_PANEL },
            content: opts.hint ?? '{gray-fg}i=insert · esc=NORMAL/cancel · NORMAL+enter=submit · INSERT+enter=newline · C-c=cancel{/gray-fg}',
        });

        // Mode indicator (top-right corner, inside the box border).
        const modeIndicator = blessed.box({
            parent: box,
            top: 0,
            right: 1,
            height: 1,
            width: 10,
            tags: true,
            style: { bg: BG_PANEL },
            content: '{gray-fg}NORMAL{/gray-fg}',
        });

        const renderModeIndicator = (m: PromptMode): void => {
            const colour = m === 'INSERT' ? 'cyan-fg' : (m === 'VISUAL' || m === 'V-LINE') ? 'yellow-fg' : 'gray-fg';
            modeIndicator.setContent(`{${colour}}${m}{/${colour}}`);
            screen.render();
        };

        const cleanup = (val: string | null): void => {
            overlay.release();
            restoreKeys();
            try { popInputPane(); } catch { /* noop */ }
            try { box.destroy(); } catch { /* noop */ }
            if (savedFocus) {
                try { (savedFocus).focus(); } catch { /* noop */ }
            }
            screen.render();
            resolve(val);
        };

        const pane = createPromptPane({
            parent: box,
            top: 0,
            // Reserve last row for the hint line.
            height: (typeof box.height === 'number' ? box.height : height) - 3,
            onSubmit: (text) => {
                const trimmed = text.replace(/\s+$/g, '');
                if (trimmed.length === 0 && (opts.emptyAsCancel ?? true)) {
                    cleanup(null);

                    return;
                }
                cleanup(trimmed);
            },
            onModeChange: renderModeIndicator,
            // CRITICAL: without onChange the pane mutates its internal
            // buffer but never schedules a re-paint, so typed chars
            // don't appear until something else triggers a render
            // (e.g. pressing escape). Force a render on every change.
            onChange: () => screen.render(),
            // Escape in NORMAL with no pending operator dismisses the
            // modal (cancel). INSERT-mode escape still falls through
            // to the pane's own handler (INSERT → NORMAL).
            onEscapeNormal: () => cleanup(null),
            ...(opts.syntaxLanguage ? { syntaxLanguage: opts.syntaxLanguage } : {}),
        });

        if (opts.initial && opts.initial.length > 0) {
            pane.setValue(opts.initial);
        }

        // Esc / C-c cancel — handled at the box level so they fire from
        // any focus state (including inside the prompt pane in NORMAL).
        box.key(['C-c'], () => cleanup(null));
        // We do NOT bind 'q' or 'escape' on the box — those are normal
        // editor keys handled inside the promptPane (esc switches INSERT
        // → NORMAL, q is a normal char). Cancel is C-c.

        pane.setFocused(true);
        pane.focus();

        // Register this pane as the topmost active input so the
        // screen-level <Space> leader handler suppresses itself while
        // we're typing in INSERT mode (just like the main prompt).
        const popInputPane = pushActiveInputPane({
            el: pane.el,
            isInsert: () => pane.mode() === 'INSERT',
        });

        // When the popup is hidden + re-shown via the global popup
        // toggle (<leader>t), `PopupRegistry.show()` focuses the topmost
        // overlay — which is THIS box, not the inner pane. Without
        // delegation the user can no longer type because the pane lost
        // focus and its keypress handlers don't fire. Forward any focus
        // event on the box to the inner pane so the modal stays usable
        // across hide/show cycles.
        box.on('focus', () => {
            try { pane.focus(); pane.setFocused(true); } catch { /* noop */ }
        });
        // Force-render the parent box so the empty content + hint show
        // immediately.
        void hint;
        screen.render();
    });
}
