import * as blessed from 'blessed';
import { highlight, supportsLanguage } from 'cli-highlight';
import { wrapAnsiLine } from './wrapAnsi';
import { escTag, sanitizeForBlessed } from '@/UI/dashboard';
import { copyViaOsc52 } from '../screen/osc52';
import { BG_PRIMARY, BORDER_DIM, FG_MUTED } from '../theme';

export type PromptMode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'V-LINE';

export interface PromptPaneOptions {
    parent: blessed.Widgets.Node;
    top: number | string;
    height: number | string;
    onModeChange?: (m: PromptMode) => void;
    /** Called when user presses Enter in NORMAL mode. */
    onSubmit?: (text: string) => void;
    /** Called on `y` (also writes OSC 52 internally). */
    onYank?: (n: number) => void;
    /** Optional history seed (most-recent first). */
    history?: string[];
    /** Called after every internal mutation/render so the host can
     *  schedule a coalesced screen repaint. Without this, key-driven
     *  edits and motions only reach blessed's element content but never
     *  trigger `screen.render()`, leaving the user staring at a stale
     *  frame. */
    onChange?: () => void;
    /** Called when the user presses Escape while in NORMAL mode. Modal
     *  hosts (e.g. freeform input popup) use this to dismiss the
     *  popup; the main prompt leaves it unset so escape-in-NORMAL is
     *  a no-op. */
    onEscapeNormal?: () => void;
    /** highlight.js language id (e.g. 'typescript', 'python'). When
     *  set, every visible line is piped through cli-highlight before
     *  display so the buffer is syntax-coloured live as the user
     *  edits. The cursor row in NORMAL mode keeps its inverse cell
     *  (no syntax) so the block cursor stays unmistakable. */
    syntaxLanguage?: string;
}

export interface PromptPane {
    el: blessed.Widgets.BoxElement;
    value: () => string;
    setValue: (v: string) => void;
    clear: () => void;
    focus: () => void;
    mode: () => PromptMode;
    /** Called by the app to push a submitted prompt into history. */
    pushHistory: (entry: string) => void;
    /** Track whether this pane currently owns focus. The cursor cell is
     *  only highlighted when focused. */
    setFocused: (focused: boolean) => void;
}

interface Pos { row: number; col: number }

const TAB_REPLACEMENT = '    ';

function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
}

function isWORDChar(ch: string): boolean {
    return ch !== ' ' && ch !== '\t';
}

export function createPromptPane(opts: PromptPaneOptions): PromptPane {
    const el = blessed.box({
        parent: opts.parent,
        top: opts.top,
        left: 0,
        right: 0,
        height: opts.height,
        border: { type: 'line' },
        label: ' prompt ',
        tags: true,
        scrollable: false,
        keys: false,
        mouse: true,
        wrap: false,
        input: true,
        keyable: true,
        focusable: true,
        style: {
            fg: 'white',
            // Match the transcript pane's soft navy background.
            bg: BG_PRIMARY,
            border: { fg: BORDER_DIM },
            label: { fg: FG_MUTED },
        },
    });

    // ---- state ---------------------------------------------------------------

    let lines: string[] = [''];
    let cursor: Pos = { row: 0, col: 0 };
    let anchor: Pos = { row: 0, col: 0 };
    let viewportTop = 0;
    let mode: PromptMode = 'NORMAL';
    // Tracks whether this pane currently owns focus; when false we render
    // the cursor cell as ordinary text so the prompt looks dormant.
    let focused = false;

    // Internal yank register (separate from OSC 52 — vim's anonymous register).
    let regText = '';
    let regLinewise = false;

    // Pending compound state.
    let pendingCount = 0;
    let pendingOp: 'g' | 'd' | 'y' | 'f' | 'F' | 't' | 'T' | null = null;
    let lastFind: { ch: string; dir: 1 | -1; type: 'f' | 't' } | null = null;

    // History.
    const history: string[] = (opts.history ?? []).slice();
    let historyIdx = -1; // -1 = current draft (not in history)
    let draftSnapshot: string | null = null; // snapshot of edited text before entering history

    // ---- undo / redo --------------------------------------------------------
    // Vim-style: every "meaningful change" pushes a snapshot. INSERT mode
    // is treated as ONE undo unit — we snapshot when entering INSERT and
    // not on every keystroke (mirrors nvim default behaviour). NORMAL
    // mutations (d, x, p, o, O, etc.) snapshot before applying.
    type UndoFrame = { lines: string[]; cursor: Pos };
    const undoStack: UndoFrame[] = [];
    const redoStack: UndoFrame[] = [];
    const UNDO_LIMIT = 200;
    const snapshotState = (): UndoFrame => ({ lines: lines.slice(), cursor: { ...cursor } });
    const pushUndo = (): void => {
        undoStack.push(snapshotState());
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        // Any new edit invalidates the redo branch (vim semantics).
        redoStack.length = 0;
    };
    const restoreFrame = (f: UndoFrame): void => {
        lines = f.lines.slice();
        cursor = { ...f.cursor };
        if (lines.length === 0) lines = [''];
        clampCursor();
    };
    const undo = (): boolean => {
        const f = undoStack.pop();
        if (!f) return false;
        redoStack.push(snapshotState());
        restoreFrame(f);

        return true;
    };
    const redo = (): boolean => {
        const f = redoStack.pop();
        if (!f) return false;
        undoStack.push(snapshotState());
        restoreFrame(f);

        return true;
    };

    // ---- geometry ------------------------------------------------------------

    const visibleHeight = (): number => {
        const h = (el as unknown as { height: number }).height;
        const total = typeof h === 'number' ? h : 8;

        return Math.max(1, total - 2);
    };

    const visibleWidth = (): number => {
        const w = (el as unknown as { width: number }).width;
        const total = typeof w === 'number' ? w : 80;

        return Math.max(1, total - 2);
    };

    const lineLen = (i: number): number => (lines[i] ?? '').length;

    const clampCursor = (): void => {
        if (cursor.row < 0) cursor.row = 0;
        if (cursor.row > lines.length - 1) cursor.row = lines.length - 1;
        const len = lineLen(cursor.row);
        // In INSERT cursor can sit at len (one past end). In NORMAL cap at len-1 unless empty.
        const cap = mode === 'INSERT' ? len : Math.max(0, len - 1);
        if (cursor.col < 0) cursor.col = 0;
        if (cursor.col > cap) cursor.col = cap;
    };

    interface VLine { logRow: number; startCol: number; endCol: number; }
    let visualLineCache: VLine[] = [];
    let lastVRow = 0;
    let lastVCol = 0;

    const buildVisualLines = (vw: number): VLine[] => {
        const out: VLine[] = [];
        for (let r = 0; r < lines.length; r++) {
            const len = (lines[r] ?? '').length;
            if (len === 0) {
                out.push({ logRow: r, startCol: 0, endCol: 0 });
                continue;
            }
            for (let c = 0; c < len; c += vw) {
                out.push({ logRow: r, startCol: c, endCol: Math.min(c + vw, len) });
            }
        }

        return out;
    };

    const cursorVisualPos = (vlines: VLine[]): { vrow: number; vcol: number } => {
        const cap = cursor.col;
        let last = -1;
        for (let i = 0; i < vlines.length; i++) {
            const v = vlines[i];
            if (v.logRow !== cursor.row) continue;
            last = i;
            if (cap >= v.startCol && cap < v.endCol) {
                return { vrow: i, vcol: cap - v.startCol };
            }
            if (cap === v.endCol && (mode === 'INSERT' || v.endCol === 0)) {
                if (v.endCol === (lines[cursor.row] ?? '').length) {
                    return { vrow: i, vcol: cap - v.startCol };
                }
            }
        }
        if (last >= 0) {
            const v = vlines[last];

            return { vrow: last, vcol: Math.min(cap - v.startCol, v.endCol - v.startCol) };
        }

        return { vrow: 0, vcol: 0 };
    };

    const ensureCursorVisible = (): void => {
        const vh = visibleHeight();
        const vw = visibleWidth();
        visualLineCache = buildVisualLines(vw);
        const { vrow } = cursorVisualPos(visualLineCache);
        if (vrow < viewportTop) viewportTop = vrow;
        if (vrow >= viewportTop + vh) viewportTop = vrow - vh + 1;
        const maxTop = Math.max(0, visualLineCache.length - vh);
        if (viewportTop > maxTop) viewportTop = maxTop;
        if (viewportTop < 0) viewportTop = 0;
    };

    // ---- selection ---------------------------------------------------------

    const orderedSel = (): { from: Pos; to: Pos } => {
        const a = anchor, b = cursor;
        const aBefore = a.row < b.row || (a.row === b.row && a.col <= b.col);

        return aBefore ? { from: a, to: b } : { from: b, to: a };
    };

    const selectedText = (): string => {
        if (mode === 'V-LINE') {
            const { from, to } = orderedSel();

            return lines.slice(from.row, to.row + 1).join('\n');
        }
        if (mode === 'VISUAL') {
            const { from, to } = orderedSel();
            if (from.row === to.row) {
                return (lines[from.row] ?? '').slice(from.col, to.col + 1);
            }
            const parts: string[] = [];
            parts.push((lines[from.row] ?? '').slice(from.col));
            for (let r = from.row + 1; r < to.row; r++) parts.push(lines[r] ?? '');
            parts.push((lines[to.row] ?? '').slice(0, to.col + 1));

            return parts.join('\n');
        }

        return '';
    };

    // ---- rendering ---------------------------------------------------------

    const fireMode = (m: PromptMode): void => {
        if (m === mode) return;
        mode = m;
        if (opts.onModeChange) opts.onModeChange(m);
        clampCursor();
    };

    const computeHighlighted = (vw: number): (string | null)[] | null => {
        const lang = opts.syntaxLanguage;
        if (!lang || !supportsLanguage(lang)) return null;
        try {
            const joined = lines.join('\n');
            const hi = highlight(joined, { language: lang, ignoreIllegals: true });
            const hiLines = hi.split('\n');
            // Truncate ANSI-aware: cli-highlight wraps tokens with
            // matching SGR pairs that don't break across lines, but
            // raw width truncation could chop mid-escape. We accept
            // overflow and let blessed clip horizontally — the pane
            // never wraps, and blessed handles ANSI clipping fine.
            void vw;

            return hiLines;
        } catch {
            return null;
        }
    };

    const positionTerminalCursor = (): void => {
        const screen = (el as unknown as { screen?: blessed.Widgets.Screen }).screen;
        if (!screen) return;
        const program = (screen as unknown as { program?: { cup: (r: number, c: number) => void; showCursor: () => void; hideCursor: () => void; cursorShape?: (s: string, b?: boolean) => void } }).program;
        if (!program) return;
        if (!focused) {
            try { program.hideCursor(); } catch { /* noop */ }

            return;
        }
        const aTop = (el as unknown as { atop: number }).atop ?? 0;
        const aLeft = (el as unknown as { aleft: number }).aleft ?? 0;
        // Border occupies one cell on each side. Use the visual row /
        // visual col captured in the most recent render() so wrapped
        // lines move the cursor to the correct *visual* row underneath.
        const row = aTop + 1 + (lastVRow - viewportTop);
        const col = aLeft + 1 + lastVCol;
        try {
            // blessed.cursorShape only honours shape when the screen runs
            // in "artificial cursor" mode — which we don't. Emit the raw
            // DECSCUSR sequence directly so a real terminal switches
            // between block (NORMAL) and bar (INSERT) like neovim does.
            //   1 = blinking block, 2 = steady block,
            //   5 = blinking bar,   6 = steady bar.
            // tmux 3.2+ tracks DECSCUSR natively and forwards it to the
            // outer terminal — NO DCS passthrough wrap is needed (and a
            // wrap is actively dropped when `allow-passthrough` is off).
            // CRITICAL ordering: blessed.program.showCursor() emits the
            // terminfo `cnorm` capability which on tmux-256color resets
            // cursor shape — so write DECSCUSR *last*, after
            // cup+showCursor, directly to /dev/tty to bypass any blessed
            // stdout buffering/wrapping.
            //   2 = steady block (NORMAL), 6 = steady bar (INSERT).
            //   (1 / 5 are the blinking variants; we use steady so the
            //    cursor doesn't pulse the whole time.)
            program.cup(row, col);
            program.showCursor();
            const seq = mode === 'INSERT' ? '\x1b[6 q' : '\x1b[2 q';
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fs = require('fs');
                const ttyFd = fs.openSync('/dev/tty', 'w');
                fs.writeSync(ttyFd, seq);
                fs.closeSync(ttyFd);
            } catch {
                try { process.stdout.write(seq); } catch { /* noop */ }
            }
        } catch { /* noop */ }
    };

    const render = (): void => {
        ensureCursorVisible();
        const vh = visibleHeight();
        const vw = visibleWidth();
        const sel = (mode === 'VISUAL' || mode === 'V-LINE') ? orderedSel() : null;
        const highlighted = computeHighlighted(vw);
        const vlines = visualLineCache;
        const cvp = cursorVisualPos(vlines);
        lastVRow = cvp.vrow;
        lastVCol = cvp.vcol;

        // Pre-wrap each highlighted logical line into ANSI-aware
        // segments so colours survive the wrap boundary.
        const wrappedHl: (string[] | null)[] = highlighted
            ? lines.map((_, r) => wrapAnsiLine(highlighted[r] ?? '', vw).map((s) => s.text))
            : lines.map(() => null);

        const out: string[] = [];
        for (let i = 0; i < vh; i++) {
            const vi = viewportTop + i;
            if (vi >= vlines.length) { out.push(''); continue; }
            const v = vlines[vi];
            const segIdx = Math.floor(v.startCol / vw);
            const hlSeg = wrappedHl[v.logRow]?.[segIdx] ?? null;
            out.push(renderVLine(v, vw, sel, hlSeg));
        }
        // Force a content change so blessed always re-renders this
        // pane. Blessed sometimes elides redraws when the joined
        // content string compares equal to the previous frame, which
        // produced ghost lines after `dd` (the deleted line stayed
        // visible until the next geometry change). Setting an empty
        // string first guarantees the diff is non-trivial.
        el.setContent('');
        el.setContent(out.join('\n'));
        const screen = (el as unknown as { screen?: blessed.Widgets.Screen }).screen;
        if (screen) {
            // blessed repaints reset the hardware cursor — re-position
            // *after* it has finished rendering this frame. Register the
            // listener BEFORE calling onChange (which synchronously fires
            // a screen.render() and would emit 'render' before this hook
            // is in place — the previous ordering meant cursor-shape and
            // position updates landed one frame late, so toggling INSERT
            // mode looked stale until the next keystroke triggered another
            // render).
            screen.once('render', () => positionTerminalCursor());
        }
        if (opts.onChange) opts.onChange();
    };

    const renderVLine = (
        v: VLine,
        vw: number,
        sel: { from: Pos; to: Pos } | null,
        highlightedLine: string | null,
    ): string => {
        const li = v.logRow;
        const raw = lines[li] ?? '';
        const piece = raw.slice(v.startCol, v.endCol);
        const truncated = piece;
        void vw;
        // We use the real terminal cursor (DECSCUSR) for cursor display
        // — NEVER overlay an in-cell block/bar. The cell stays
        // unmolested so the character at the insertion point is always
        // readable (matches neovim: thin bar in INSERT, block on top in
        // NORMAL, both without pushing characters around).
        const showCursor = false;

        let selStart = -1, selEnd = -1;
        if (sel) {
            if (mode === 'V-LINE') {
                if (li >= sel.from.row && li <= sel.to.row) {
                    selStart = 0;
                    selEnd = Math.max(0, truncated.length - 1);
                }
            } else if (li >= sel.from.row && li <= sel.to.row) {
                const rawFrom = (li === sel.from.row) ? sel.from.col : 0;
                const rawTo = (li === sel.to.row) ? sel.to.col : (raw.length - 1);
                const segLo = v.startCol;
                const segHi = v.endCol - 1;
                const overlapFrom = Math.max(rawFrom, segLo);
                const overlapTo = Math.min(rawTo, segHi);
                if (overlapFrom <= overlapTo && truncated.length > 0) {
                    selStart = overlapFrom - segLo;
                    selEnd = overlapTo - segLo;
                }
            }
        }

        if (!showCursor && selStart < 0) {
            // cli-highlight emits raw ANSI escapes (\x1b[...m). blessed
            // renders those natively when `tags: true` *and* the
            // content is fed verbatim — DO NOT route through
            // sanitizeForBlessed which strips the ESC byte and leaves
            // literal `[33m` garbage in the buffer.
            if (highlightedLine !== null) return highlightedLine;

            return escTag(truncated);
        }

        let out = '';
        const cellsNeeded = Math.max(truncated.length, showCursor && cursor.col >= truncated.length ? cursor.col + 1 : 0);
        for (let c = 0; c < cellsNeeded; c++) {
            const ch = c < truncated.length ? truncated[c] : ' ';
            const isCursor = showCursor && c === cursor.col;
            const isSel = selStart >= 0 && c >= selStart && c <= selEnd;
            const cell = escTag(ch);
            if (isCursor && mode === 'INSERT') {
                // INSERT: thin vertical bar drawn BEFORE the cell content
                // so the character at the insertion gap stays visible
                // (vim's `ver25` cursor shape, but as a separator instead
                // of an overlay since blessed paints by full cells).
                out += `{cyan-fg}▏{/cyan-fg}${cell}`;
            } else if (isCursor && isSel) {
                out += `{black-fg}{magenta-bg}${cell}{/magenta-bg}{/black-fg}`;
            } else if (isCursor) {
                // NORMAL: full-cell block cursor in cyan (thick line),
                // keeping the character readable on top.
                out += `{cyan-bg}{black-fg}${cell}{/black-fg}{/cyan-bg}`;
            } else if (isSel) {
                out += `{black-fg}{yellow-bg}${cell}{/yellow-bg}{/black-fg}`;
            } else {
                out += cell;
            }
        }

        return out;
    };

    // ---- buffer mutation --------------------------------------------------

    const value = (): string => lines.join('\n');

    const setValue = (v: string): void => {
        const sanitized = sanitizeForBlessed(v).replace(/\t/g, TAB_REPLACEMENT);
        lines = sanitized.split('\n');
        if (lines.length === 0) lines = [''];
        cursor = { row: lines.length - 1, col: lineLen(lines.length - 1) };
        anchor = { ...cursor };
        viewportTop = 0;
        clampCursor();
        render();
    };

    const clear = (): void => {
        lines = [''];
        cursor = { row: 0, col: 0 };
        anchor = { ...cursor };
        viewportTop = 0;
        historyIdx = -1;
        draftSnapshot = null;
        if (mode !== 'INSERT' && mode !== 'NORMAL') fireMode('NORMAL');
        render();
    };

    const insertChar = (ch: string): void => {
        const r = cursor.row;
        const line = lines[r] ?? '';
        // Bracketed / fast-typing pastes deliver the entire blob —
        // including embedded newlines — in a single keypress event.
        // Splice the rows so the buffer holds proper multi-line content
        // (otherwise the \n bytes get embedded in a single line and
        // blessed renders them garbled, hence "can only see one line").
        if (ch.indexOf('\n') >= 0 || ch.indexOf('\r') >= 0) {
            const pieces = ch.replace(/\r\n?/g, '\n').split('\n');
            const head = line.slice(0, cursor.col) + pieces[0];
            const tail = pieces[pieces.length - 1] + line.slice(cursor.col);
            const middle = pieces.slice(1, -1);
            lines.splice(r, 1, head, ...middle, tail);
            cursor.row = r + pieces.length - 1;
            cursor.col = pieces[pieces.length - 1].length;
        } else {
            lines[r] = line.slice(0, cursor.col) + ch + line.slice(cursor.col);
            cursor.col += ch.length;
        }
        render();
    };

    const insertNewline = (): void => {
        const r = cursor.row;
        const line = lines[r] ?? '';
        const left = line.slice(0, cursor.col);
        const right = line.slice(cursor.col);
        lines[r] = left;
        lines.splice(r + 1, 0, right);
        cursor.row = r + 1;
        cursor.col = 0;
        render();
    };

    const deleteCharBefore = (): void => {
        if (cursor.col > 0) {
            const r = cursor.row;
            const line = lines[r] ?? '';
            lines[r] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
            cursor.col--;
        } else if (cursor.row > 0) {
            const above = lines[cursor.row - 1] ?? '';
            const here = lines[cursor.row] ?? '';
            lines[cursor.row - 1] = above + here;
            lines.splice(cursor.row, 1);
            cursor.row--;
            cursor.col = above.length;
        }
        render();
    };

    const deleteCharUnder = (): void => {
        const r = cursor.row;
        const line = lines[r] ?? '';
        if (line.length === 0) return;
        regText = line[cursor.col] ?? '';
        regLinewise = false;
        lines[r] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
        clampCursor();
        render();
    };

    const deleteSelection = (): void => {
        if (mode !== 'VISUAL' && mode !== 'V-LINE') return;
        const { from, to } = orderedSel();
        regText = selectedText();
        regLinewise = (mode === 'V-LINE');
        if (mode === 'V-LINE') {
            lines.splice(from.row, to.row - from.row + 1);
            if (lines.length === 0) lines = [''];
            cursor = { row: Math.min(from.row, lines.length - 1), col: 0 };
        } else if (from.row === to.row) {
            const line = lines[from.row] ?? '';
            lines[from.row] = line.slice(0, from.col) + line.slice(to.col + 1);
            cursor = { ...from };
        } else {
            const head = (lines[from.row] ?? '').slice(0, from.col);
            const tail = (lines[to.row] ?? '').slice(to.col + 1);
            lines.splice(from.row, to.row - from.row + 1, head + tail);
            cursor = { ...from };
        }
        anchor = { ...cursor };
        fireMode('NORMAL');
        render();
    };

    const deleteCurrentLine = (): void => {
        regText = lines[cursor.row] ?? '';
        regLinewise = true;
        lines.splice(cursor.row, 1);
        if (lines.length === 0) lines = [''];
        if (cursor.row >= lines.length) cursor.row = lines.length - 1;
        cursor.col = 0;
        render();
    };

    const yankCurrentLine = (): void => {
        regText = lines[cursor.row] ?? '';
        regLinewise = true;
        copyViaOsc52(regText);
        if (opts.onYank) opts.onYank(regText.length);
    };

    const yankSelection = (): void => {
        const text = selectedText();
        if (!text) return;
        regText = text;
        regLinewise = (mode === 'V-LINE');
        copyViaOsc52(text);
        if (opts.onYank) opts.onYank(text.length);
        fireMode('NORMAL');
        render();
    };

    const paste = (): void => {
        if (!regText) return;
        if (regLinewise) {
            const insertAt = cursor.row + 1;
            const pieces = regText.split('\n');
            lines.splice(insertAt, 0, ...pieces);
            cursor.row = insertAt;
            cursor.col = 0;
        } else {
            const r = cursor.row;
            const line = lines[r] ?? '';
            const at = Math.min(line.length, cursor.col + 1);
            const pieces = regText.split('\n');
            if (pieces.length === 1) {
                lines[r] = line.slice(0, at) + pieces[0] + line.slice(at);
                cursor.col = at + pieces[0].length - 1;
            } else {
                const head = line.slice(0, at) + pieces[0];
                const tail = pieces[pieces.length - 1] + line.slice(at);
                const middle = pieces.slice(1, -1);
                lines.splice(r, 1, head, ...middle, tail);
                cursor.row = r + pieces.length - 1;
                cursor.col = pieces[pieces.length - 1].length - 1;
            }
        }
        clampCursor();
        render();
    };

    // ---- motions (mirror of transcript, slimmed) ---------------------------

    const moveBy = (drow: number, dcol: number, n: number): void => {
        cursor.row += drow * n;
        cursor.col += dcol * n;
        clampCursor();
    };
    const moveLineStart = (): void => { cursor.col = 0; };
    // Paragraph motion: a paragraph boundary is a blank (whitespace-only)
    // line. `{` jumps to the previous boundary, `}` to the next.
    // Mirrors vim's `{` / `}` motions.
    const isBlankLine = (i: number): boolean => /^\s*$/.test(lines[i] ?? '');
    const moveParagraph = (dir: 1 | -1, count: number): void => {
        for (let n = 0; n < count; n++) {
            let r = cursor.row + dir;
            // Skip over the run of blank lines we may already be inside.
            while (r >= 0 && r < lines.length && isBlankLine(r)) r += dir;
            // Now walk until we hit the next blank line OR the buffer edge.
            while (r >= 0 && r < lines.length && !isBlankLine(r)) r += dir;
            if (r < 0) r = 0;
            else if (r >= lines.length) r = lines.length - 1;
            cursor.row = r;
            cursor.col = 0;
        }
        clampCursor();
    };
    const moveLineEnd = (): void => {
        const len = lineLen(cursor.row);
        cursor.col = mode === 'INSERT' ? len : Math.max(0, len - 1);
    };
    const moveFirstNonBlank = (): void => {
        const m = (lines[cursor.row] ?? '').match(/^\s*/);
        cursor.col = m ? m[0].length : 0;
    };

    const moveWordForward = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            const here = lines[r][c];
            if (here !== undefined && isWord(here)) {
                while (c < lineLen(r) && isWord(lines[r][c])) c++;
            } else {
                while (c < lineLen(r) && !isWord(lines[r][c]) && lines[r][c] !== ' ') c++;
            }
            while (true) {
                if (c >= lineLen(r)) {
                    if (r >= lines.length - 1) { c = lineLen(r); break; }
                    r++; c = 0; continue;
                }
                if (lines[r][c] === ' ') { c++; continue; }
                break;
            }
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const moveWordBackward = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            if (c > 0) c--; else if (r > 0) { r--; c = lineLen(r); }
            while (true) {
                if (lines[r][c] === ' ') {
                    if (c > 0) c--; else if (r > 0) { r--; c = lineLen(r); } else break;
                    continue;
                }
                break;
            }
            const cls = isWord(lines[r][c] ?? '');
            while (c > 0 && isWord(lines[r][c - 1] ?? '') === cls && lines[r][c - 1] !== ' ') c--;
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const moveWordEnd = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            c++;
            while (true) {
                if (c >= lineLen(r)) {
                    if (r >= lines.length - 1) { c = Math.max(0, lineLen(r) - 1); break; }
                    r++; c = 0; continue;
                }
                if (lines[r][c] === ' ') { c++; continue; }
                break;
            }
            const cls = isWord(lines[r][c] ?? '');
            while (c + 1 < lineLen(r) && isWord(lines[r][c + 1] ?? '') === cls && lines[r][c + 1] !== ' ') c++;
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const findInLine = (ch: string, dir: 1 | -1, type: 'f' | 't', n: number): void => {
        const line = lines[cursor.row] ?? '';
        let c = cursor.col;
        for (let i = 0; i < n; i++) {
            if (dir === 1) {
                const pos = line.indexOf(ch, c + 1);
                if (pos < 0) return;
                c = type === 't' ? pos - 1 : pos;
            } else {
                const pos = line.lastIndexOf(ch, c - 1);
                if (pos < 0) return;
                c = type === 't' ? pos + 1 : pos;
            }
        }
        cursor.col = c;
        clampCursor();
    };

    // ---- history -----------------------------------------------------------

    const loadHistoryAt = (idx: number): void => {
        if (idx < 0 || idx >= history.length) return;
        if (historyIdx === -1) draftSnapshot = value();
        historyIdx = idx;
        const v = history[idx];
        lines = v.split('\n');
        if (lines.length === 0) lines = [''];
        cursor = { row: lines.length - 1, col: lineLen(lines.length - 1) };
        if (mode === 'NORMAL') cursor.col = Math.max(0, cursor.col - 1);
        anchor = { ...cursor };
        viewportTop = 0;
        clampCursor();
        render();
    };

    const restoreDraft = (): void => {
        if (draftSnapshot === null) return;
        const v = draftSnapshot;
        draftSnapshot = null;
        historyIdx = -1;
        lines = v.split('\n');
        if (lines.length === 0) lines = [''];
        cursor = { row: lines.length - 1, col: lineLen(lines.length - 1) };
        if (mode === 'NORMAL') cursor.col = Math.max(0, cursor.col - 1);
        anchor = { ...cursor };
        clampCursor();
        render();
    };

    const tryHistoryUp = (): boolean => {
        if (cursor.row !== 0) return false;
        if (history.length === 0) return false;
        const next = historyIdx === -1 ? 0 : Math.min(history.length - 1, historyIdx + 1);
        if (next === historyIdx) return true;
        loadHistoryAt(next);

        return true;
    };

    const tryHistoryDown = (): boolean => {
        if (cursor.row !== lines.length - 1) return false;
        if (historyIdx === -1) return false;
        if (historyIdx === 0) { restoreDraft();

 return true; }
        loadHistoryAt(historyIdx - 1);

        return true;
    };

    // ---- key dispatch ------------------------------------------------------

    const enterInsert = (placeAt?: 'before' | 'after' | 'lineStart' | 'lineEnd'): void => {
        // Snapshot pre-insert state — the entire INSERT session collapses
        // to one undo step, matching nvim default behaviour.
        pushUndo();
        switch (placeAt) {
            case 'after': cursor.col = Math.min(lineLen(cursor.row), cursor.col + 1); break;
            case 'lineStart': moveFirstNonBlank(); break;
            case 'lineEnd': cursor.col = lineLen(cursor.row); break;
        }
        fireMode('INSERT');
        render();
    };

    const onKeyInsert = (ch: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
        const name = key.name ?? '';
        if (name === 'escape') {
            // Vim moves cursor left when leaving INSERT.
            cursor.col = Math.max(0, cursor.col - 1);
            fireMode('NORMAL');
            render();

            return;
        }
        if (key.ctrl) {
            if (name === 'u') {
                const r = cursor.row;
                const line = lines[r] ?? '';
                lines[r] = line.slice(cursor.col);
                cursor.col = 0;
                render();

                return;
            }
            if (name === 'w') {
                const r = cursor.row;
                const line = lines[r] ?? '';
                let c = cursor.col;
                while (c > 0 && line[c - 1] === ' ') c--;
                while (c > 0 && line[c - 1] !== ' ') c--;
                lines[r] = line.slice(0, c) + line.slice(cursor.col);
                cursor.col = c;
                render();

                return;
            }
        }
        // Backspace: handle every form blessed/terminals deliver it as.
        // The `name === 'backspace'` branch covers most cases, but some
        // pastes / fast-typing deliver the byte without a key name (raw
        // 0x7f DEL or 0x08 BS in `ch`), and macOS occasionally surfaces
        // it as `name === 'delete'`.
        if (name === 'backspace' || name === 'delete'
            || ch === '\x7f' || ch === '\x08'
        ) {
            deleteCharBefore();

            return;
        }
        if (name === 'enter' || name === 'return') { insertNewline();

 return; }
        if (name === 'tab') { insertChar(TAB_REPLACEMENT);

 return; }
        if (name === 'left') { moveBy(0, -1, 1); render();

 return; }
        if (name === 'right') { moveBy(0, 1, 1); render();

 return; }
        if (name === 'up') { moveBy(-1, 0, 1); render();

 return; }
        if (name === 'down') { moveBy(1, 0, 1); render();

 return; }
        if (name === 'home') { moveLineStart(); render();

 return; }
        if (name === 'end') { moveLineEnd(); render();

 return; }
        if (ch && ch.length >= 1) {
            // Multi-char blob — a real bracketed/fast paste. Let
            // insertChar split embedded \n / \r\n into proper rows.
            if (ch.length > 1) {
                insertChar(sanitizeForBlessed(ch));

                return;
            }
            // Single-char path: terminals deliver pasted newlines /
            // tabs as bare bytes (no `name`), so the explicit
            // 'enter'/'tab' branches above miss them. Route them
            // through the proper editing primitives.
            if (ch === '\n' || ch === '\r') { insertNewline();

 return; }
            if (ch === '\t') { insertChar(TAB_REPLACEMENT);

 return; }
            // Reject every other sub-space control byte.
            if (ch < ' ') return;
            insertChar(sanitizeForBlessed(ch));
        }
    };

    const onKeyNormal = (ch: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
        const name = key.name ?? '';
        const count = pendingCount > 0 ? pendingCount : 1;

        if (ch && /^[0-9]$/.test(ch) && !(ch === '0' && pendingCount === 0)) {
            pendingCount = pendingCount * 10 + Number(ch);

            return;
        }

        if (pendingOp === 'g') {
            pendingOp = null;
            if (ch === 'g') { cursor.row = pendingCount > 0 ? pendingCount - 1 : 0; cursor.col = 0; clampCursor(); }
            pendingCount = 0;
            render();

            return;
        }
        if (pendingOp === 'd') {
            pendingOp = null;
            pushUndo();
            // Treat arrow keys identically to their h/j/k/l motion in
            // operator-pending state — mirrors vim's behavior so
            // `d<right>` deletes one char to the right (== `dl`),
            // `d<down>` deletes the current line + the line below
            // (== `dj`, linewise), etc.
            const motion = ch ?? (
                name === 'left' ? 'h' :
                name === 'right' ? 'l' :
                name === 'down' ? 'j' :
                name === 'up' ? 'k' :
                ''
            );
            if (motion === 'd' || motion === 'j' || motion === 'k') {
                // Linewise delete: dd / dj / dk.
                let n = count;
                if (motion === 'j' || motion === 'k') n = count + 1;
                if (motion === 'k') {
                    // dk deletes current line + `count` lines above.
                    for (let i = 0; i < count && cursor.row > 0; i++) cursor.row--;
                }
                for (let i = 0; i < n; i++) deleteCurrentLine();
            }
            else if (motion === 'h') {
                // Charwise delete left: count chars before the cursor.
                const r = cursor.row; const line = lines[r] ?? '';
                const startCol = Math.max(0, cursor.col - count);
                regText = line.slice(startCol, cursor.col); regLinewise = false;
                lines[r] = line.slice(0, startCol) + line.slice(cursor.col);
                cursor.col = startCol; clampCursor();
            }
            else if (motion === 'l') {
                // Charwise delete right: `count` chars at/after the cursor.
                const r = cursor.row; const line = lines[r] ?? '';
                const endCol = Math.min(line.length, cursor.col + count);
                regText = line.slice(cursor.col, endCol); regLinewise = false;
                lines[r] = line.slice(0, cursor.col) + line.slice(endCol);
                clampCursor();
            }
            else if (motion === 'w') { const start = { ...cursor }; moveWordForward(count, isWordChar); deleteRange(start, cursor); }
            else if (motion === 'b') { const end = { ...cursor }; moveWordBackward(count, isWordChar); deleteRange(cursor, end, false); }
            else if (motion === '$' || name === 'end') { const r = cursor.row; const line = lines[r] ?? ''; regText = line.slice(cursor.col); regLinewise = false; lines[r] = line.slice(0, cursor.col); clampCursor(); }
            else if (motion === '0' || name === 'home') { const r = cursor.row; const line = lines[r] ?? ''; regText = line.slice(0, cursor.col); regLinewise = false; lines[r] = line.slice(cursor.col); cursor.col = 0; }
            pendingCount = 0;
            render();

            return;
        }
        if (pendingOp === 'y') {
            pendingOp = null;
            // Same arrow-as-motion remap as the `d` operator above.
            const motion = ch ?? (
                name === 'left' ? 'h' :
                name === 'right' ? 'l' :
                name === 'down' ? 'j' :
                name === 'up' ? 'k' :
                ''
            );
            if (motion === 'y') {
                yankCurrentLine();
            }
            else if (motion === 'j' || motion === 'k') {
                // Linewise yank yj / yk — yank a contiguous range of lines.
                const before = { ...cursor };
                let startRow = cursor.row;
                let endRow = cursor.row;
                if (motion === 'j') endRow = Math.min(lines.length - 1, cursor.row + count);
                else startRow = Math.max(0, cursor.row - count);
                regText = lines.slice(startRow, endRow + 1).join('\n') + '\n';
                regLinewise = true;
                cursor = before;
                copyViaOsc52(regText);
                if (opts.onYank) opts.onYank(regText.length);
            }
            else if (motion === 'h' || motion === 'l') {
                const before = { ...cursor };
                const r = cursor.row; const line = lines[r] ?? '';
                const startCol = motion === 'h' ? Math.max(0, cursor.col - count) : cursor.col;
                const endCol = motion === 'l' ? Math.min(line.length, cursor.col + count) : cursor.col;
                regText = line.slice(startCol, endCol); regLinewise = false;
                cursor = before;
                copyViaOsc52(regText);
                if (opts.onYank) opts.onYank(regText.length);
            }
            else if (motion === 'w') { const start = { ...cursor }; const before = { ...cursor }; moveWordForward(count, isWordChar); regText = textBetween(start, cursor); regLinewise = false; cursor = before; copyViaOsc52(regText); if (opts.onYank) opts.onYank(regText.length); }
            pendingCount = 0;
            render();

            return;
        }
        if (pendingOp === 'f' || pendingOp === 'F' || pendingOp === 't' || pendingOp === 'T') {
            const op = pendingOp;
            pendingOp = null;
            if (ch && ch.length === 1) {
                const dir: 1 | -1 = (op === 'f' || op === 't') ? 1 : -1;
                const type: 'f' | 't' = (op === 'f' || op === 'F') ? 'f' : 't';
                lastFind = { ch, dir, type };
                findInLine(ch, dir, type, count);
            }
            pendingCount = 0;
            render();

            return;
        }

        if (name === 'escape') {
            if (mode !== 'NORMAL') {
                fireMode('NORMAL');
                pendingCount = 0; pendingOp = null;
                render();

                return;
            }
            // Already in NORMAL: clear any pending operator first; if
            // there's nothing pending and a host opted in, bubble up
            // so the modal can dismiss itself.
            if (pendingCount !== 0 || pendingOp !== null) {
                pendingCount = 0; pendingOp = null;
                render();

                return;
            }
            if (opts.onEscapeNormal) {
                opts.onEscapeNormal();

                return;
            }
            render();

            return;
        }

        // History navigation lives behind explicit Ctrl-P / Ctrl-N
        // bindings (handled below). Up / down / k / j stay reserved
        // for cursor movement — if you're at the top line, you stay
        // there. The previous "up at row 0 jumps to last submission"
        // behaviour was constantly clobbering in-flight prompts.
        if (key.ctrl && name === 'p' && mode === 'NORMAL') {
            if (tryHistoryUp()) return;
        }
        if (key.ctrl && name === 'n' && mode === 'NORMAL') {
            if (tryHistoryDown()) return;
        }
        // Ctrl-R = redo (vim default).
        if (key.ctrl && name === 'r' && mode === 'NORMAL') {
            if (redo()) render();

            return;
        }

        if (name === 'enter' || name === 'return') {
            // Submit
            const text = value();
            if (text.trim() && opts.onSubmit) opts.onSubmit(text);

            return;
        }

        switch (ch) {
            case 'h': moveBy(0, -1, count); render();

 return;
            case 'l': moveBy(0, 1, count); render();

 return;
            case 'j': moveBy(1, 0, count); render();

 return;
            case 'k': moveBy(-1, 0, count); render();

 return;
            case '0': moveLineStart(); render();

 return;
            case '^': moveFirstNonBlank(); render();

 return;
            case '$': moveLineEnd(); render();

 return;
            case 'w': moveWordForward(count, isWordChar); render();

 return;
            case 'W': moveWordForward(count, isWORDChar); render();

 return;
            case 'b': moveWordBackward(count, isWordChar); render();

 return;
            case 'B': moveWordBackward(count, isWORDChar); render();

 return;
            case 'e': moveWordEnd(count, isWordChar); render();

 return;
            case 'E': moveWordEnd(count, isWORDChar); render();

 return;
            case 'g': pendingOp = 'g';

 return;
            case 'G': cursor.row = pendingCount > 0 ? pendingCount - 1 : lines.length - 1; cursor.col = 0; clampCursor(); pendingCount = 0; render();

 return;
            case 'f': pendingOp = 'f';

 return;
            case 'F': pendingOp = 'F';

 return;
            case 't': pendingOp = 't';

 return;
            case 'T': pendingOp = 'T';

 return;
            case ';': if (lastFind) findInLine(lastFind.ch, lastFind.dir, lastFind.type, count); render();

 return;
            case ',': if (lastFind) findInLine(lastFind.ch, (-lastFind.dir) as 1 | -1, lastFind.type, count); render();

 return;
            case '{': moveParagraph(-1, count); render();

 return;
            case '}': moveParagraph(1, count); render();

 return;
            case 'i': enterInsert();

 return;
            case 'I': enterInsert('lineStart');

 return;
            case 'a': enterInsert('after');

 return;
            case 'A': enterInsert('lineEnd');

 return;
            case 'o': {
                pushUndo();
                lines.splice(cursor.row + 1, 0, '');
                cursor.row++; cursor.col = 0;
                fireMode('INSERT');
                render();

                return;
            }
            case 'O': {
                pushUndo();
                lines.splice(cursor.row, 0, '');
                cursor.col = 0;
                fireMode('INSERT');
                render();

                return;
            }
            case 'u': if (undo()) render();

 return;
            case 'x': { pushUndo(); deleteCharUnder(); }

 return;
            case 'd':
                if (mode === 'VISUAL' || mode === 'V-LINE') { pushUndo(); deleteSelection();

 return; }
                pendingOp = 'd';

                return;
            case 'y':
                if (mode === 'VISUAL' || mode === 'V-LINE') { yankSelection();

 return; }
                pendingOp = 'y';

                return;
            case 'p': { pushUndo(); paste(); }

 return;
            case 'v':
                if (mode === 'VISUAL') fireMode('NORMAL');
                else { anchor = { ...cursor }; fireMode('VISUAL'); }
                render();

                return;
            case 'V':
                if (mode === 'V-LINE') fireMode('NORMAL');
                else { anchor = { ...cursor }; fireMode('V-LINE'); }
                render();

                return;
        }

        if (name === 'left') { moveBy(0, -1, count); render();

 return; }
        if (name === 'right') { moveBy(0, 1, count); render();

 return; }
        if (name === 'up') { moveBy(-1, 0, count); render();

 return; }
        if (name === 'down') { moveBy(1, 0, count); render();

 return; }
        if (name === 'home') { moveLineStart(); render();

 return; }
        if (name === 'end') { moveLineEnd(); render();

 return; }
        pendingCount = 0;
    };

    // helpers used by NORMAL operators
    const textBetween = (from: Pos, to: Pos): string => {
        const a = (from.row < to.row || (from.row === to.row && from.col <= to.col)) ? from : to;
        const b = a === from ? to : from;
        if (a.row === b.row) return (lines[a.row] ?? '').slice(a.col, b.col);
        const parts: string[] = [];
        parts.push((lines[a.row] ?? '').slice(a.col));
        for (let r = a.row + 1; r < b.row; r++) parts.push(lines[r] ?? '');
        parts.push((lines[b.row] ?? '').slice(0, b.col));

        return parts.join('\n');
    };

    const deleteRange = (from: Pos, to: Pos, _inclusiveEnd = false): void => {
        regText = textBetween(from, to);
        regLinewise = false;
        const a = (from.row < to.row || (from.row === to.row && from.col <= to.col)) ? from : to;
        const b = a === from ? to : from;
        if (a.row === b.row) {
            const line = lines[a.row] ?? '';
            lines[a.row] = line.slice(0, a.col) + line.slice(b.col);
        } else {
            const head = (lines[a.row] ?? '').slice(0, a.col);
            const tail = (lines[b.row] ?? '').slice(b.col);
            lines.splice(a.row, b.row - a.row + 1, head + tail);
        }
        cursor = { ...a };
        clampCursor();
    };

    // Some terminal/blessed combos deliver a single Enter (or other
    // named key) as TWO synchronous keypress events — once with
    // `key.name='return'` and once as a bare `ch='\r'`. That made
    // Enter advance two rows in INSERT mode. Suppress an exact-duplicate
    // keypress that fires within the same micro-window.
    // Some terminal/blessed combos deliver a single Enter as TWO
    // synchronous keypress events — once with `name=enter` and once
    // with `name=return`, but with bytes that DON'T always match
    // exactly (one event may carry seq="\r", the other seq="\r\n" or
    // even an empty ch). Dedupe by:
    //   1) Any Enter-class keypress within ENTER_DEDUPE_MS of the
    //      previous Enter-class keypress is dropped (handles the split
    //      enter/return double-fire).
    //   2) Otherwise, identical (ch + sequence) signatures within 5ms
    //      are dropped (handles other byte-level dupes).
    // 30ms is comfortably below typical OS key-repeat (~33ms = 30Hz
    // "fast" repeat), so legitimate auto-repeated Enter still fires.
    const ENTER_DEDUPE_MS = 30;
    let lastEnterAt = 0;
    let lastSig = '';
    let lastSigAt = 0;
    el.on('keypress', (ch, key) => {
        const screen = (el as unknown as { screen?: { focused?: blessed.Widgets.BlessedElement } }).screen;
        if (screen && screen.focused !== el) return;
        const k = key as { name?: string; full?: string; sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean };
        const name = k.name ?? '';
        const isEnterClass = name === 'enter' || name === 'return' || ch === '\r' || ch === '\n';
        const now = Date.now();
        if (isEnterClass) {
            if (now - lastEnterAt < ENTER_DEDUPE_MS) return;
            lastEnterAt = now;
        } else {
            const sig = `${ch ?? ''}|${k.sequence ?? ''}`;
            if (sig === lastSig && now - lastSigAt < 5) return;
            lastSig = sig;
            lastSigAt = now;
        }
        if (mode === 'INSERT') onKeyInsert(ch as string | undefined, key as { name?: string; ctrl?: boolean });
        else onKeyNormal(ch as string | undefined, key as { name?: string; ctrl?: boolean });
    });

    el.on('focus', () => {
        // No auto-INSERT — user starts in NORMAL (Vim convention).
        focused = true;
        render();
    });

    el.on('blur', () => {
        focused = false;
        const screen = (el as unknown as { screen?: blessed.Widgets.Screen }).screen;
        const program = (screen as unknown as { program?: { hideCursor: () => void } } | undefined)?.program;
        try { program?.hideCursor(); } catch { /* noop */ }
        render();
    });

    const screen = (el as unknown as { screen?: blessed.Widgets.Screen }).screen;
    if (screen) screen.on('resize', () => render());

    if (opts.history) for (const h of opts.history) history.push(h);

    render();

    return {
        el,
        value,
        setValue,
        clear,
        focus: () => el.focus(),
        mode: () => mode,
        pushHistory: (entry) => {
            if (!entry) return;
            // Dedupe consecutive duplicates.
            if (history.length > 0 && history[0] === entry) return;
            history.unshift(entry);
            if (history.length > 200) history.length = 200;
            historyIdx = -1;
            draftSnapshot = null;
        },
        setFocused: (f) => {
            if (f === focused) return;
            focused = f;
            render();
        },
    };
}
