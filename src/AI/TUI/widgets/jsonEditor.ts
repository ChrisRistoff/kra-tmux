import * as blessed from 'blessed';
import { markOverlay } from '../state/popupRegistry';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM, FG_BODY, FG_MUTED, ACCENT_BLUE, ACCENT_CYAN, ACCENT_RED, ACCENT_GREEN, ACCENT_MAGENTA, ACCENT_YELLOW } from '../theme';

const ACTIVE_BG = '#2e3450';

export interface OpenJsonEditorOptions {
    title: string;
    initial: unknown;
}

type FieldKind = 'string' | 'number' | 'boolean' | 'json';

interface Field {
    key: string;
    kind: FieldKind;
    /** Stable shadow value, updated whenever the user leaves a field. */
    value: string;
    /** Original parsed value — used to infer kind on save. */
    original: unknown;
    /** Row container (label + input). */
    row: blessed.Widgets.BoxElement;
    label: blessed.Widgets.BoxElement;
    input: blessed.Widgets.TextboxElement;
}

/**
 * In-TUI editor for tool-call arguments.
 *
 * Layout: one row per top-level key, with a colored label on the left
 * and an always-active blessed.textbox on the right. Tab / Shift-Tab
 * navigate. Ctrl-S saves and validates. Esc cancels the whole edit.
 *
 * The active field uses high-contrast colors (yellow background, black
 * text) so it's obvious where focus is.
 *
 * Returns the edited value, or null if the user cancels.
 */
export async function openJsonEditor(
    screen: blessed.Widgets.Screen,
    opts: OpenJsonEditorOptions,
): Promise<unknown | null> {
    const isPlainObject = !!opts.initial
        && typeof opts.initial === 'object'
        && !Array.isArray(opts.initial);

    if (isPlainObject) {
        return openFieldForm(screen, opts.title, opts.initial as Record<string, unknown>);
    }

    return openRawJsonEditor(screen, opts.title, opts.initial);
}

// --- field-by-field form -------------------------------------------------

function openFieldForm(
    screen: blessed.Widgets.Screen,
    title: string,
    initial: Record<string, unknown>,
): Promise<unknown | null> {
    return new Promise((resolve) => {
        const savedFocus = screen.focused;

        const entries = Object.entries(initial);
        const usableHeight = Math.min(entries.length * 2 + 6, screen.height as number - 4);

        const box = blessed.box({
            parent: screen,
            top: 'center',
            left: 'center',
            width: '85%',
            height: usableHeight,
            label: ` ${title} `,
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
            tags: true,
        });
        box.setFront();
        const overlay = markOverlay(box, {
            screen,
            pausedKeys: ['C-s', 'C-c', 'q', 'escape', 'tab', 'S-tab'],
        });
        const restoreKeys = (): void => overlay.release();

        blessed.box({
            parent: box,
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            tags: true,
            style: { fg: FG_MUTED, bg: BG_PANEL },
            content:
                ` {${ACCENT_CYAN}-fg}[Tab/Shift-Tab]{/} navigate fields  ` +
                `{${ACCENT_CYAN}-fg}[Ctrl-S]{/} save  ` +
                `{${ACCENT_RED}-fg}[Esc]{/} cancel\n` +
                ` {${FG_MUTED}-fg}Numbers/booleans/null parsed automatically; ` +
                `JSON literals (start with [ {{ or "") are JSON.parse'd.{/}`,
        });

        const status = blessed.box({
            parent: box,
            bottom: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: true,
            style: { fg: FG_MUTED, bg: BG_PANEL },
            content: '',
        });

        // Build a row per field.
        const fields: Field[] = [];
        const rowsTop = 2;
        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            const kind = inferKind(value);

            const row = blessed.box({
                parent: box,
                top: rowsTop + i * 2,
                left: 1,
                right: 1,
                height: 1,
                tags: true,
                style: { bg: BG_PRIMARY },
            });

            const label = blessed.box({
                parent: row,
                top: 0,
                left: 0,
                width: 28,
                height: 1,
                tags: true,
                style: { fg: FG_MUTED, bg: BG_PANEL },
            });

            const input = blessed.textbox({
                parent: row,
                top: 0,
                left: 28,
                right: 0,
                height: 1,
                inputOnFocus: false,
                keys: false,
                mouse: false,
                style: { fg: FG_BODY, bg: BG_PANEL },
            });

            const valueStr = stringifyForKind(value, kind);
            input.setValue(valueStr);

            fields.push({ key, kind, value: valueStr, original: value, row, label, input });
        }

        let current = 0;

        const renderLabels = (): void => {
            for (let i = 0; i < fields.length; i++) {
                const f = fields[i];
                const isCur = i === current;
                const kindBadge = `{${kindColor(f.kind)}-fg}[${f.kind}]{/}`;
                const keyText = isCur
                    ? `{${ACCENT_BLUE}-fg} ${escapeTags(f.key)} {/} ${kindBadge}`
                    : ` ${escapeTags(f.key)} ${kindBadge}`;
                f.label.setContent(keyText);

                if (isCur) {
                    f.input.style.fg = FG_BODY;
                    f.input.style.bg = ACTIVE_BG;
                } else {
                    f.input.style.fg = FG_BODY;
                    f.input.style.bg = BG_PANEL;
                }
            }
            screen.render();
        };

        let activeListener: ((ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => void) | null = null;

        const cleanup = (result: unknown | null): void => {
            // Force-exit any active readInput cleanly.
            if (activeListener) {
                const cur = fields[current];
                cur.input.removeListener('keypress', activeListener);
                activeListener = null;
                const inputAny = cur.input as unknown as { _done?: (e: unknown, v: unknown) => void };
                if (inputAny._done) inputAny._done(null, null);
            }
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(result);
        };

        // Captures current input.value into shadow + exits readInput.
        const commitCurrent = (): void => {
            const cur = fields[current];
            const liveValue = (cur.input as unknown as { value?: string }).value;
            if (typeof liveValue === 'string') cur.value = liveValue;
            if (activeListener) {
                cur.input.removeListener('keypress', activeListener);
                activeListener = null;
            }
            const inputAny = cur.input as unknown as { _done?: (e: unknown, v: unknown) => void };
            if (inputAny._done) inputAny._done(null, null);
            // Reflect committed value in the visible textbox.
            cur.input.setValue(cur.value);
        };

        const trySave = (): void => {
            commitCurrent();
            const out: Record<string, unknown> = {};
            for (const f of fields) {
                const parsed = parseForKind(f.value, f.kind);
                if (parsed.ok) {
                    out[f.key] = parsed.value;
                } else {
                    status.setContent(`{red-fg} ✗ ${f.key}: ${parsed.error}{/red-fg}`);
                    screen.render();
                    activate(fields.findIndex((x) => x.key === f.key));

                    return;
                }
            }
            cleanup(out);
        };

        const navigate = (delta: number): void => {
            commitCurrent();
            current = (current + delta + fields.length) % fields.length;
            activate(current);
        };

        const activate = (idx: number): void => {
            current = idx;
            renderLabels();
            const cur = fields[current];
            // Make sure the displayed text matches the shadow before re-entering input mode.
            cur.input.setValue(cur.value);
            cur.input.focus();
            cur.input.readInput(() => {
                // Native readInput callback fires on Enter/Esc in the textbox.
                // Our intercept (below) handles Tab/S-Tab/Ctrl-S/Esc explicitly,
                // so this almost never runs. Sync shadow defensively.
                const live = (cur.input as unknown as { value?: string }).value;
                if (typeof live === 'string') cur.value = live;
            });

            const onKey = (_ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): void => {
                const name = key.name ?? '';
                // Ctrl-S → save (must intercept here because grabKeys=true while readInput active)
                if (key.ctrl && name === 's') {
                    trySave();
                    return;
                }
                // Ctrl-C / Esc → cancel
                if (name === 'escape' || (key.ctrl && name === 'c')) {
                    cleanup(null);
                    return;
                }
                // Tab / Shift-Tab → navigate
                if (name === 'tab') {
                    navigate(key.shift ? -1 : 1);
                    return;
                }
                // Enter → commit current and move to next field (intuitive)
                if (name === 'return' || name === 'enter') {
                    if (current === fields.length - 1) {
                        trySave();
                    } else {
                        navigate(1);
                    }
                    return;
                }
            };

            cur.input.on('keypress', onKey);
            activeListener = onKey;
        };

        renderLabels();
        activate(0);
    });
}

// --- raw JSON fallback ----------------------------------------------------

function openRawJsonEditor(
    screen: blessed.Widgets.Screen,
    title: string,
    initial: unknown,
): Promise<unknown | null> {
    return new Promise((resolve) => {
        const savedFocus = screen.focused;

        const box = blessed.box({
            parent: screen,
            top: 'center',
            left: 'center',
            width: '85%',
            height: '70%',
            label: ` ${title} (raw JSON) `,
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
            tags: true,
        });
        box.setFront();
        const overlay = markOverlay(box, {
            screen,
            pausedKeys: ['C-s', 'C-c', 'q', 'escape'],
        });
        const restoreKeys = (): void => overlay.release();

        blessed.box({
            parent: box,
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: true,
            style: { fg: FG_MUTED, bg: BG_PANEL },
            content: ` {${ACCENT_CYAN}-fg}[Ctrl-S]{/} save  {${ACCENT_RED}-fg}[Esc / Ctrl-C]{/} cancel`,
        });

        const status = blessed.box({
            parent: box,
            bottom: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: true,
            style: { fg: FG_MUTED, bg: BG_PANEL },
            content: '',
        });

        const ta = blessed.textarea({
            parent: box,
            top: 1,
            left: 1,
            right: 1,
            bottom: 1,
            inputOnFocus: true,
            keys: true,
            mouse: true,
            scrollable: true,
            style: { fg: FG_BODY, bg: BG_PANEL },
        });

        try {
            ta.setValue(JSON.stringify(initial, null, 2));
        } catch {
            ta.setValue(String(initial));
        }

        const cleanup = (result: unknown | null): void => {
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(result);
        };

        const trySave = (): void => {
            const raw = ta.getValue();
            try {
                cleanup(JSON.parse(raw));
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                status.setContent(`{red-fg} ✗ JSON parse error: ${msg}{/red-fg}`);
                screen.render();
            }
        };

        ta.key(['C-s'], trySave);
        ta.key(['escape', 'C-c'], () => cleanup(null));

        ta.focus();
        screen.render();
    });
}

// --- helpers --------------------------------------------------------------

function inferKind(v: unknown): FieldKind {
    if (typeof v === 'string') return 'string';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';

    return 'json';
}

function kindColor(kind: FieldKind): string {
    switch (kind) {
        case 'string':  return ACCENT_GREEN;
        case 'number':  return ACCENT_MAGENTA;
        case 'boolean': return ACCENT_CYAN;
        default:        return ACCENT_YELLOW;
    }
}

function stringifyForKind(v: unknown, kind: FieldKind): string {
    if (kind === 'string') return v == null ? '' : String(v);
    if (kind === 'number' || kind === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

interface ParseOk  { ok: true;  value: unknown }
interface ParseErr { ok: false; error: string }

function parseForKind(raw: string, kind: FieldKind): ParseOk | ParseErr {
    if (kind === 'string') return { ok: true, value: raw };
    if (kind === 'number') {
        if (raw === '') return { ok: false, error: 'expected a number' };
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${raw}` };

        return { ok: true, value: n };
    }
    if (kind === 'boolean') {
        if (raw === 'true')  return { ok: true, value: true };
        if (raw === 'false') return { ok: true, value: false };

        return { ok: false, error: `expected true/false, got: ${raw}` };
    }
    // json
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        return { ok: false, error: `invalid JSON (${msg})` };
    }
}

function escapeTags(s: string): string {
    return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}
