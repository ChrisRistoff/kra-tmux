/**
 * Tool-approval modal for the chat TUI. Designed to be reusable: the agent
 * (`kra ai agent`) can later swap its lua popup for this same widget by
 * sending the same `ToolApprovalPayload` shape.
 *
 * Layout:
 *   ┌─ Approve tool · web_fetch ──────────────────────────┐
 *   │ Tool       web_fetch                               │
 *   │ What       Fetches a single URL …                  │
 *   │ Summary    URL: https://example.com/foo            │
 *   │                                                    │
 *   │ Args (raw JSON, scrollable)                        │
 *   │ {                                                  │
 *   │   "url": "https://example.com/foo"                 │
 *   │ }                                                  │
 *   │                                                    │
 *   │ Actions  (↑/↓ + Enter, or hotkeys)                 │
 *   │  ❯ [a] Allow once   — run with current args        │
 *   │    [f] Allow family — skip future approvals …      │
 *   │    …                                               │
 *   └────────────────────────────────────────────────────┘
 */

import * as blessed from 'blessed';
import { openJsonEditor } from './jsonEditor';
import { markOverlay } from '../state/popupRegistry';
import { showFreeformInputModal } from './freeformInputModal';
import { showDiffReviewModal } from './diffReviewModal';
import { BG_PRIMARY, BG_PANEL } from '../theme';
import type { ToolWritePreview } from '@/AI/AIAgent/shared/types/agentTypes';

export interface ToolApprovalPayload {
    /** Tool function name (e.g. `web_fetch`). */
    toolName: string;
    /** Optional sub-agent label that prefixes the title. */
    agentLabel?: string;
    /** Title shown in the modal border. */
    title: string;
    /** One-line summary derived from args (URL/command/query/path/…). */
    summary: string;
    /** Multi-section body (Tool/What/Summary, joined by \n). */
    details: string;
    /** Pretty-printed JSON of the tool args. */
    argsJson: string;
    /** Original raw args object — used as the seed when the user picks Edit. */
    toolArgs: unknown;
    /** Optional write preview — enables the "Review" diff editor action. */
    writePreview?: ToolWritePreview;
}

export type ToolApprovalDecision =
    | { action: 'allow', modifiedArgs?: unknown }
    | { action: 'allow-family' }
    | { action: 'yolo' }
    | { action: 'deny', denyReason?: string };

interface ActionItem {
    id: 'allow' | 'allow-family' | 'yolo' | 'edit' | 'review' | 'deny';
    hotkey: string;
    label: string;
    description: string;
    color: string;
}

const ACTIONS: ActionItem[] = [
    { id: 'allow',        hotkey: 'a', label: 'Allow once',    description: 'Run this tool now with the current args.',                   color: 'green' },
    { id: 'allow-family', hotkey: 'f', label: 'Allow family',  description: 'Skip future approvals for this tool family in this session.', color: 'cyan' },
    { id: 'yolo',         hotkey: 'y', label: 'YOLO mode',     description: 'Stop asking for tool approvals until session end.',           color: 'magenta' },
    { id: 'edit',         hotkey: 'e', label: 'Edit args',     description: 'Open the in-TUI JSON editor to tweak args before running.',   color: 'yellow' },
    { id: 'review',       hotkey: 'r', label: 'Review diff',   description: 'Open the side-by-side diff editor (only for write tools).',  color: 'blue' },
    { id: 'deny',         hotkey: 'd', label: 'Deny',          description: 'Block this tool call. You can give a reason.',                color: 'red' },
];

export async function showApprovalModal(
    screen: blessed.Widgets.Screen,
    payload: ToolApprovalPayload,
): Promise<ToolApprovalDecision> {
    let currentArgs: unknown = payload.toolArgs;
    let currentArgsJson = payload.argsJson;

    while (true) {
        const choice = await openOnce(screen, {
            ...payload,
            toolArgs: currentArgs,
            argsJson: currentArgsJson,
        });

        if (choice.kind === 'edit') {
            const edited = await openJsonEditor(screen, {
                title: `Edit args · ${payload.toolName}`,
                initial: currentArgs,
            });
            if (edited === null) continue;
            currentArgs = edited;
            try { currentArgsJson = JSON.stringify(edited, null, 2); } catch { currentArgsJson = String(edited); }
            continue;
        }
        if (choice.kind === 'review') {
            if (!payload.writePreview) continue;
            const result = await showDiffReviewModal(screen, {
                toolName: payload.toolName,
                displayPath: payload.writePreview.displayPath,
                currentContent: payload.writePreview.currentContent,
                proposedContent: payload.writePreview.proposedContent,
                proposedEndsWithNewline: payload.writePreview.proposedEndsWithNewline,
                ...(payload.writePreview.note ? { note: payload.writePreview.note } : {}),
            });
            if (result.kind === 'cancel') continue;
            if (result.kind === 'edit-json') {
                // Fall through to the JSON editor on the next iteration.
                const edited = await openJsonEditor(screen, {
                    title: `Edit args · ${payload.toolName}`,
                    initial: currentArgs,
                });
                if (edited === null) continue;
                currentArgs = edited;
                try { currentArgsJson = JSON.stringify(edited, null, 2); } catch { currentArgsJson = String(edited); }
                continue;
            }
            if (result.kind === 'deny') {
                return result.reason
                    ? { action: 'deny', denyReason: result.reason }
                    : { action: 'deny' };
            }
            // approve: build modifiedArgs honouring the apply strategy.
            const preview = payload.writePreview;
            let nextText = result.editedContent;
            // Restore trailing newline semantics from the preview.
            if (preview.proposedEndsWithNewline && !nextText.endsWith('\n')) {
                nextText = nextText + '\n';
            }
            // Clone original args so we don't mutate the caller's object.
            const baseArgs: Record<string, unknown> = (currentArgs && typeof currentArgs === 'object'
                ? { ...(currentArgs as Record<string, unknown>) }
                : {});
            if (preview.applyStrategy === 'content-field') {
                const field = preview.contentField ?? (Object.prototype.hasOwnProperty.call(baseArgs, 'newContent') ? 'newContent' : 'content');
                baseArgs[field] = nextText;
            } else {
                // edit-tool strategies (anchor_edit, str_replace, edit).
                if (result.userEdited) {
                    // Tell the agent to swap in the user's final content
                    // verbatim instead of the AI's proposed strings.
                    baseArgs.__userFinalContent = nextText;
                    baseArgs.__userEditNotify = true;
                } else {
                    // Plain accept — leave args untouched.
                }
            }

            return result.userEdited || preview.applyStrategy === 'content-field'
                ? { action: 'allow', modifiedArgs: baseArgs }
                : { action: 'allow' };
        }
        if (choice.kind === 'allow') {
            return currentArgs === payload.toolArgs
                ? { action: 'allow' }
                : { action: 'allow', modifiedArgs: currentArgs };
        }
        if (choice.kind === 'allow-family') return { action: 'allow-family' };
        if (choice.kind === 'yolo') return { action: 'yolo' };
        if (choice.kind === 'deny') {
            return choice.reason
                ? { action: 'deny', denyReason: choice.reason }
                : { action: 'deny' };
        }
    }
}

type Choice =
    | { kind: 'allow' }
    | { kind: 'allow-family' }
    | { kind: 'yolo' }
    | { kind: 'edit' }
    | { kind: 'review' }
    | { kind: 'deny', reason?: string };

// Naive single-line JSON syntax tagger (blessed `tags: true`).
function colorizeJson(line: string): string {
    // Keys: "foo": -> cyan
    // Strings: "..."  -> green
    // Numbers / true / false / null -> yellow
    // Punctuation { } [ ] , : -> default
    return line.replace(/("(?:\\.|[^"\\])*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g,
        (_m, str, colon, num, lit) => {
            if (str && colon) return `{cyan-fg}${escapeTags(str)}{/cyan-fg}${colon}`;
            if (str)          return `{green-fg}${escapeTags(str)}{/green-fg}`;
            if (num)          return `{yellow-fg}${num}{/yellow-fg}`;
            if (lit)          return `{yellow-fg}${lit}{/yellow-fg}`;

            return _m;
        });
}

function escapeTags(s: string): string {
    return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

async function openOnce(
    screen: blessed.Widgets.Screen,
    payload: ToolApprovalPayload,
): Promise<Choice> {
    return new Promise((resolve) => {
        const savedFocus = screen.focused;

        const titleText = payload.agentLabel
            ? ` 󰯄 ${payload.agentLabel} \u2192 ${payload.toolName} `
            : ` 󰯄 ${payload.toolName} `;

        const box = blessed.box({
            parent: screen,
            label: titleText,
            top: 'center',
            left: 'center',
            width: '85%',
            height: '85%',
            border: { type: 'line' },
            style: { border: { fg: 'yellow' }, bg: BG_PRIMARY },
            tags: true,
        });
        box.setFront();
        const overlay = markOverlay(box, {
            screen,
            pausedKeys: ['q', 'C-c', 'escape', 'tab', 'S-tab'],
        });
        const restoreKeys = (): void => overlay.release();

        // ── Header section ──────────────────────────────────────
        const detailLines = payload.details.split('\n');
        const headerHeight = Math.min(detailLines.length + 2, 10);

        const header = blessed.box({
            parent: box,
            top: 0,
            left: 1,
            right: 1,
            height: headerHeight,
            tags: true,
            style: { bg: BG_PRIMARY },
            content: detailLines
                .map((line) => {
                    const m = line.match(/^([A-Z][\w ]*?):\s*(.*)$/);
                    if (m) {
                        return `{cyan-fg}${escapeTags(m[1])}:{/cyan-fg} ${escapeTags(m[2])}`;
                    }

                    return escapeTags(line);
                })
                .join('\n'),
        });
        void header;

        // ── Args JSON section ───────────────────────────────────
        const argsLabel = blessed.box({
            parent: box,
            top: headerHeight,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            style: { bg: BG_PANEL },
            content: '{gray-fg}── Args (raw JSON) ─────────────────────────{/gray-fg}',
        });
        void argsLabel;

        const visibleActions = ACTIONS.filter((a) => a.id !== 'review' || !!payload.writePreview);
        const actionsHeight = visibleActions.length + 3;
        const argsBox = blessed.box({
            parent: box,
            top: headerHeight + 1,
            left: 1,
            right: 1,
            bottom: actionsHeight + 1,
            tags: true,
            scrollable: true,
            alwaysScroll: true,
            keys: true,
            mouse: true,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: { bg: BG_PRIMARY, fg: 'white' },
            content: payload.argsJson.split('\n').map(colorizeJson).join('\n'),
        });
        void argsBox;

        // ── Action list ─────────────────────────────────────────
        const actionsLabel = blessed.box({
            parent: box,
            bottom: actionsHeight,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            style: { bg: BG_PANEL },
            content: '{gray-fg}── Actions  (\u2191/\u2193 + Enter, or hotkey) ───────{/gray-fg}',
        });
        void actionsLabel;

        let selected = 0;

        const list = blessed.box({
            parent: box,
            bottom: 0,
            left: 1,
            right: 1,
            height: actionsHeight,
            tags: true,
            style: { bg: BG_PRIMARY },
            content: '',
        });

        const renderList = (): void => {
            const lines = visibleActions.map((a, i) => {
                const marker = i === selected ? '\u276F' : ' ';
                const lbl = i === selected
                    ? `{inverse}{${a.color}-fg}[${a.hotkey}] ${a.label}{/${a.color}-fg}{/inverse}`
                    : `{${a.color}-fg}[${a.hotkey}] ${a.label}{/${a.color}-fg}`;

                return `${marker} ${lbl} {gray-fg}\u2014 ${a.description}{/gray-fg}`;
            });
            list.setContent(lines.join('\n'));
            screen.render();
        };
        renderList();

        const cleanup = (): void => {
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
        };

        const finish = (c: Choice): void => {
            cleanup();
            resolve(c);
        };

        const dispatch = (id: ActionItem['id']): void => {
            if (id === 'edit') { cleanup(); resolve({ kind: 'edit' });

 return; }
            if (id === 'review') {
                if (!payload.writePreview) {
                    // No diff to review for this tool — no-op (the
                    // action is hidden from the list when there's no
                    // preview, but defend against direct hotkey).
                    return;
                }
                cleanup();
                resolve({ kind: 'review' });

                return;
            }
            if (id === 'deny') {
                // Do NOT cleanup() yet — if the user escapes out of
                // the deny-reason popup we want to drop them back into
                // the approval modal instead of denying with no reason.
                void promptDenyReason(screen).then((reason) => {
                    if (reason === null) {
                        // User cancelled the reason popup; restore
                        // focus to the approval modal and let them
                        // pick again.
                        try { box.focus(); } catch { /* noop */ }
                        screen.render();

                        return;
                    }
                    const trimmed = reason.trim();
                    cleanup();
                    // Empty (or whitespace-only) string → deny with the
                    // agent's default deny message instead of an empty
                    // user-supplied reason.
                    resolve(trimmed.length > 0
                        ? { kind: 'deny', reason: trimmed }
                        : { kind: 'deny' });
                });

                return;
            }
            finish({ kind: id });
        };

        box.key(['up', 'k'], () => { selected = (selected - 1 + visibleActions.length) % visibleActions.length; renderList(); });
        box.key(['down', 'j'], () => { selected = (selected + 1) % visibleActions.length; renderList(); });
        box.key(['enter'], () => dispatch(visibleActions[selected].id));

        for (const a of visibleActions) {
            box.key([a.hotkey, a.hotkey.toUpperCase()], () => dispatch(a.id));
        }
        box.key(['escape', 'q', 'C-c'], () => finish({ kind: 'deny' }));

        box.focus();
        screen.render();
    });
}

async function promptDenyReason(screen: blessed.Widgets.Screen): Promise<string | null> {
    // Re-uses the shared multi-line freeform modal so the deny-reason
    // popup behaves identically to `ask_kra` and the agent's other
    // user-input prompts (NORMAL/INSERT modes, bigger box).
    return showFreeformInputModal(screen, {
        title: 'Deny reason (optional — empty submits with default message)',
        borderFg: 'red',
        hint: '{gray-fg}i=insert · esc=cancel · NORMAL+enter=submit (empty=default reason) · INSERT+enter=newline{/gray-fg}',
        // Empty submit must NOT be treated as cancel — it means
        // "deny with the default reason". The caller distinguishes:
        // null = cancel (back to approval modal), '' = deny no-reason.
        emptyAsCancel: false,
    });
}

