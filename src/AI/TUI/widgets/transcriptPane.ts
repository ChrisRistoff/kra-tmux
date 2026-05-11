import * as blessed from 'blessed';
import { escTag, sanitizeForBlessed } from '@/UI/dashboard';
import { stripWideChars } from './stripWide';
import { copyViaOsc52 } from '../screen/osc52';
import { truncateAndPad } from './ansiWidth';
import { BG_PRIMARY, BORDER_DIM, FG_MUTED } from '../theme';
import { wrapAnsiLine } from './wrapAnsi';

export type TranscriptMode = 'NORMAL' | 'VISUAL' | 'V-LINE';

export interface TranscriptPaneOptions {
    parent: blessed.Widgets.Node;
    top: number | string;
    height: number | string;
    /** Hard cap on stored lines; older lines are dropped. */
    maxLines?: number;
    /** Called when the mode changes (so the status bar can react). */
    onModeChange?: (m: TranscriptMode) => void;
    /** Called when something is yanked, so the UI can flash a toast. */
    onYank?: (charsCopied: number) => void;
    /** Called when the user submits a `/` search; receives the pattern. */
    onSearch?: (pattern: string) => void;
    /** Called after every internal mutation/render so the host can
     *  schedule a coalesced screen repaint. Without this, key-driven
     *  motions only reach blessed's element content but never trigger
     *  `screen.render()`, leaving the user staring at a stale frame. */
    onChange?: () => void;
}

export interface TranscriptPane {
    el: blessed.Widgets.BoxElement;
    /** Append a chunk of text (may contain `\n`). Sticks to tail unless user scrolled away. */
    append: (text: string) => void;
    /** Replace all content. */
    set: (text: string) => void;
    /** Number of stored lines. */
    lineCount: () => number;
    /** Override (or clear) the styled rendering for a given row. Pass an
     *  empty string to fall back to the per-cell plain rendering. */
    setLineStyled: (row: number, styled: string, wrapStyled?: boolean) => void;
    /** Drop the `count` completed rows immediately before the live tail
     *  slot, then append the supplied batch as new completed rows (each
     *  with its own styled rendering). The live tail slot is preserved
     *  empty afterwards. Used by the streaming markdown renderer to
     *  swap provisional code-fence rows for highlighted ones in place. */
    replaceLastLines: (count: number, batch: { plain: string; styled: string; wrapStyled?: boolean }[]) => void;
    /** Overwrite the in-progress live tail line with the given plain text
     *  and (optional) styled rendering. Used by the streaming markdown
     *  renderer to redraw the partial last line as new chunks arrive. */
    setTail: (plain: string, styled: string) => void;
    /** Current mode. */
    mode: () => TranscriptMode;
    /** Scroll/jump to last line and re-enable tail-stickiness. */
    jumpToTail: () => void;
    /** Lock/unlock the tail. While locked, sticky-tail is forced to true
     *  and any user scrolling that would clear it is overridden. Released
     *  when the prompt pane is hidden so the user can free-scroll. */
    setTailLocked: (locked: boolean) => void;
    /** Track whether this pane currently owns focus. The cursor cell is
     *  only highlighted when focused; unfocused panes paint nothing on
     *  the cursor row. */
    setFocused: (focused: boolean) => void;
    /** Current visible viewport width in columns (inside the box border). */
    viewportWidth: () => number;
}

interface Pos { row: number; col: number }

const TAB_REPLACEMENT = '    ';

function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
}

function isWORDChar(ch: string): boolean {
    return ch !== ' ' && ch !== '\t';
}

export function createTranscriptPane(opts: TranscriptPaneOptions): TranscriptPane {
    const maxLines = opts.maxLines ?? 5000;
    const trimTo = Math.floor(maxLines * 0.9);

    const el = blessed.box({
        parent: opts.parent,
        top: opts.top,
        left: 0,
        right: 0,
        height: opts.height,
        border: { type: 'line' },
        label: ' transcript ',
        tags: true,
        scrollable: false,
        keys: false,
        mouse: true,
        wrap: false, // logical line == visual row; long lines truncate
        style: {
            fg: 'white',
            // Soft dark navy so the surface reads as a tinted panel
            // instead of pure black — easier on the eyes during long
            // sessions while preserving contrast for the markdown palette.
            bg: BG_PRIMARY,
            border: { fg: BORDER_DIM },
            label: { fg: FG_MUTED },
        },
    });

    // ---- state ---------------------------------------------------------------

    let lines: string[] = [''];
    // Parallel to `lines`: when true the row should soft-wrap by its
    // *styled* visible width instead of the plain length. Set by the
    // markdown table renderer so wide box rows wrap onto extra visual
    // rows instead of getting silently truncated at the viewport edge.
    // Defaults to false so role-banner rows (with their 500-char bg pad)
    // still render as a single coloured strip.
    let wrapByStyled: boolean[] = [false];
    // Parallel array of pre-styled rendering for each line. Empty string
    // means "use per-cell plain rendering". Mirrors lines[] mutations.
    let styledLines: string[] = [''];
    let pendingTail = ''; // partial last line (no trailing \n yet)

    let mode: TranscriptMode = 'NORMAL';
    let cursor: Pos = { row: 0, col: 0 };
    // Tracks whether this pane currently owns focus; when false the cursor
    // cell is rendered as ordinary text (no inverse highlight).
    let focused = false;
    let anchor: Pos = { row: 0, col: 0 }; // visual anchor
    let viewportTop = 0;
    let stickyTail = true;
    // When tailLocked is true, all assignments to stickyTail are forced back
    // to true. Used by chatTuiApp to pin the transcript to the bottom while
    // the prompt pane is visible (per-user UX rule). When the prompt is
    // hidden, the lock is released so the user can free-scroll.
    let tailLocked = false;
    let lastFind: { ch: string; dir: 1 | -1; type: 'f' | 't' } | null = null;
    let lastSearch: { pattern: string; dir: 1 | -1 } | null = null;

    // Pending keystrokes for compound commands.
    let pendingCount = 0; // numeric prefix like 5j
    let pendingOp: 'g' | 'z' | 'f' | 'F' | 't' | 'T' | null = null;

    // Search input state
    let searchInput: string | null = null;

    const fireMode = (m: TranscriptMode): void => {
        if (m === mode) return;
        mode = m;
        if (opts.onModeChange) opts.onModeChange(m);
    };

    // ---- geometry ------------------------------------------------------------

    const visibleHeight = (): number => {
        const h = (el as unknown as { height: number }).height;
        const total = typeof h === 'number' ? h : 24;

        // box has a 1-cell border top + bottom
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
        if (cursor.col < 0) cursor.col = 0;
        if (cursor.col > Math.max(0, len - 1)) cursor.col = Math.max(0, len - 1);
    };

    interface VLine { logRow: number; startCol: number; endCol: number; segIdx: number; }
    let visualLineCache: VLine[] = [];
    let wrappedStyledCache: (string[] | null)[] = [];

    const buildVisualLines = (vw: number): VLine[] => {
        const out: VLine[] = [];
        const wrappedStyled: (string[] | null)[] = [];
        for (let r = 0; r < lines.length; r++) {
            const len = (lines[r] ?? '').length;
            const styled = styledLines[r] ?? '';
            if (styled) {
                const segs = wrapAnsiLine(styled, vw);
                // Default: cap visual rows by the *plain* line's wrap
                // count. Some renderers (e.g. role banners) intentionally
                // pad their styled output with 500+ background-coloured
                // spaces so `truncateAndPad` can fill the full viewport
                // row in colour. Without the cap each padded space
                // would become its own wrapped visual row, producing a
                // multi-row banner instead of a single coloured strip.
                // Opt-out: rows flagged `wrapByStyled` (markdown tables)
                // use ALL produced segments so the wide box drawing
                // wraps onto extra visual rows instead of truncating at
                // the viewport edge.
                const plainRows = Math.max(1, Math.ceil(len / vw));
                const useSegs = wrapByStyled[r] ? segs : segs.slice(0, plainRows);
                wrappedStyled.push(useSegs.map((s) => s.text));
                if (useSegs.length === 0) {
                    out.push({ logRow: r, startCol: 0, endCol: 0, segIdx: 0 });
                } else {
                    let cursorCol = 0;
                    let idx = 0;
                    for (const seg of useSegs) {
                        const startCol = cursorCol;
                        const endCol = Math.min(len, startCol + seg.cols);
                        out.push({ logRow: r, startCol, endCol, segIdx: idx });
                        cursorCol += seg.cols;
                        idx++;
                    }
                }
                continue;
            }
            wrappedStyled.push(null);
            if (len === 0) {
                out.push({ logRow: r, startCol: 0, endCol: 0, segIdx: 0 });
                continue;
            }
            let idx = 0;
            for (let c = 0; c < len; c += vw) {
                out.push({ logRow: r, startCol: c, endCol: Math.min(c + vw, len), segIdx: idx });
                idx++;
            }
        }
        wrappedStyledCache = wrappedStyled;

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
            if (cap === v.endCol && cap === (lines[cursor.row] ?? '').length) {
                return { vrow: i, vcol: cap - v.startCol };
            }
        }
        if (last >= 0) {
            const v = vlines[last];

            return { vrow: last, vcol: Math.max(0, Math.min(cap - v.startCol, v.endCol - v.startCol)) };
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

    const isAtTail = (): boolean => {
        // Stickiness should re-engage only when the user has parked the
        // CURSOR on the live tail line (the empty trailing slot). The
        // older viewport-based check returned true any time the bottom of
        // the buffer was visible, which made every `j`/`l`/word-jump snap
        // the cursor straight to the last row.
        return cursor.row >= lines.length - 1;
    };

    // ---- selection ----------------------------------------------------------

    const orderedSel = (): { from: Pos; to: Pos } => {
        const a = anchor, b = cursor;
        const aBefore = a.row < b.row || (a.row === b.row && a.col <= b.col);

        return aBefore ? { from: a, to: b } : { from: b, to: a };
    };

    const selectedText = (): string => {
        if (mode === 'NORMAL') return lines[cursor.row] ?? '';
        const { from, to } = orderedSel();
        if (mode === 'V-LINE') {
            return lines.slice(from.row, to.row + 1).join('\n');
        }
        // V (char) — inclusive both ends
        if (from.row === to.row) {
            return (lines[from.row] ?? '').slice(from.col, to.col + 1);
        }
        const parts: string[] = [];
        parts.push((lines[from.row] ?? '').slice(from.col));
        for (let r = from.row + 1; r < to.row; r++) parts.push(lines[r] ?? '');
        parts.push((lines[to.row] ?? '').slice(0, to.col + 1));

        return parts.join('\n');
    };

    // ---- rendering ----------------------------------------------------------

    const render = (): void => {
        const vh = visibleHeight();
        const vw = visibleWidth();
        // Tail-lock override: when the prompt pane is visible, the
        // transcript is pinned to the bottom regardless of any scroll
        // input. Keystrokes and wheel events may have flipped sticky
        // off; the lock re-asserts it on every render.
        if (tailLocked) stickyTail = true;
        if (stickyTail) {
            cursor.row = lines.length - 1;
            cursor.col = Math.max(0, lineLen(cursor.row));
            visualLineCache = buildVisualLines(vw);
            viewportTop = Math.max(0, visualLineCache.length - vh);
        }
        ensureCursorVisible();

        const sel = (mode !== 'NORMAL') ? orderedSel() : null;
        const vlines = visualLineCache;

        const out: string[] = [];
        for (let i = 0; i < vh; i++) {
            const vi = viewportTop + i;
            if (vi >= vlines.length) { out.push(''); continue; }
            const v = vlines[vi];
            out.push(renderVLine(v, vw, sel, v.segIdx));
        }
        if (searchInput !== null && out.length > 0) {
            const prompt = `/${searchInput}`;
            const padded = prompt.length >= vw ? prompt.slice(0, vw) : prompt + ' '.repeat(vw - prompt.length);
            out[out.length - 1] = `{black-fg}{yellow-bg}${escTag(padded)}{/yellow-bg}{/black-fg}`;
        }
        el.setContent(out.join('\n'));
        if (opts.onChange) opts.onChange();
    };

    const renderVLine = (
        v: VLine,
        vw: number,
        sel: { from: Pos; to: Pos } | null,
        segIdx: number,
    ): string => {
        const li = v.logRow;
        const raw = lines[li] ?? '';
        const piece = raw.slice(v.startCol, v.endCol);
        const truncated = piece;
        const showCursor = focused
            && (li === cursor.row)
            && (cursor.col >= v.startCol)
            && (cursor.col < v.endCol
                || (cursor.col === v.endCol && cursor.col === raw.length));

        // Search-match ranges that intersect this visual segment.
        // currentRange marks the match the cursor is sitting on (highlighted differently).
        const searchPat = activeSearchPattern();
        const searchRanges: Array<[number, number]> = [];
        let currentRange: [number, number] | null = null;
        if (searchPat) {
            const hits = computeSearchHits(li, searchPat);
            const segLo = v.startCol;
            const segHi = v.endCol - 1;
            for (const h of hits) {
                const lo = Math.max(h, segLo);
                const hi = Math.min(h + searchPat.length - 1, segHi);
                if (lo <= hi) {
                    const range: [number, number] = [lo - segLo, hi - segLo];
                    const isCurrent = (li === cursor.row) && (h === cursor.col);
                    if (isCurrent) currentRange = range;
                    else searchRanges.push(range);
                }
            }
        }

        // Decide selection range on this visual segment.
        let selStart = -1, selEnd = -1;
        if (sel) {
            if (mode === 'V-LINE') {
                if (li >= sel.from.row && li <= sel.to.row) {
                    selStart = 0;
                    selEnd = Math.max(0, truncated.length - 1);
                }
            } else if (li >= sel.from.row && li <= sel.to.row) {
                const rawFrom = (li === sel.from.row) ? sel.from.col : 0;
                const rawTo = (li === sel.to.row) ? sel.to.col : raw.length - 1;
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

        if (!showCursor && selStart < 0 && searchRanges.length === 0 && !currentRange) {
            const wrapped = wrappedStyledCache[li];
            if (wrapped) {
                const seg = wrapped[segIdx] ?? '';

                return truncateAndPad(seg, vw);
            }

            return escTag(truncated.padEnd(vw, ' '));
        }

        // Build with per-cell tags (selection bg + cursor inverse).
        const localCursor = showCursor ? cursor.col - v.startCol : -1;
        let out = '';
        const len = Math.max(truncated.length, showCursor && localCursor >= truncated.length ? localCursor + 1 : 0);
        for (let c = 0; c < len; c++) {
            const ch = c < truncated.length ? truncated[c] : ' ';
            const isCursor = showCursor && c === localCursor;
            const isSel = selStart >= 0 && c >= selStart && c <= selEnd;
            let isMatch = false;
            for (const [a, b] of searchRanges) { if (c >= a && c <= b) { isMatch = true; break; } }
            const isCurrentMatch = currentRange !== null && c >= currentRange[0] && c <= currentRange[1];
            const cell = escTag(ch);
            if (isCursor && isSel) {
                out += `{black-fg}{magenta-bg}${cell}{/magenta-bg}{/black-fg}`;
            } else if (isCursor) {
                out += `{inverse}${cell}{/inverse}`;
            } else if (isCurrentMatch) {
                out += `{black-fg}{yellow-bg}${cell}{/yellow-bg}{/black-fg}`;
            } else if (isMatch) {
                out += `{black-fg}{cyan-bg}${cell}{/cyan-bg}{/black-fg}`;
            } else if (isSel) {
                out += `{black-fg}{yellow-bg}${cell}{/yellow-bg}{/black-fg}`;
            } else {
                out += cell;
            }
        }
        if (len < vw) out += ' '.repeat(vw - len);

        return out;
    };

    // ---- buffer mutation -----------------------------------------------------

    const trim = (): void => {
        if (lines.length <= maxLines) return;
        const drop = lines.length - trimTo;
        lines = lines.slice(drop);
        styledLines = styledLines.slice(drop);
        wrapByStyled = wrapByStyled.slice(drop);
        cursor.row = Math.max(0, cursor.row - drop);
        anchor.row = Math.max(0, anchor.row - drop);
        viewportTop = Math.max(0, viewportTop - drop);
    };

    const append = (text: string): void => {
        if (!text) return;
        const sanitized = stripWideChars(sanitizeForBlessed(text)).replace(/\t/g, TAB_REPLACEMENT);
        const combined = pendingTail + sanitized;
        const parts = combined.split('\n');
        pendingTail = parts.pop() ?? '';
        if (parts.length > 0) {
            // Replace in-progress slot with first completed line, then push rest.
            lines[lines.length - 1] = parts[0];
            styledLines[styledLines.length - 1] = '';
            wrapByStyled[wrapByStyled.length - 1] = false;
            for (let i = 1; i < parts.length; i++) {
                lines.push(parts[i]);
                styledLines.push('');
                wrapByStyled.push(false);
            }
            lines.push(pendingTail); // re-establish a slot for live tail
            styledLines.push('');
            wrapByStyled.push(false);
        } else {
            lines[lines.length - 1] = combined;
            styledLines[styledLines.length - 1] = '';
            wrapByStyled[wrapByStyled.length - 1] = false;
        }
        trim();
        render();
    };

    const set = (text: string): void => {
        lines = [''];
        styledLines = [''];
        wrapByStyled = [false];
        pendingTail = '';
        cursor = { row: 0, col: 0 };
        anchor = { row: 0, col: 0 };
        viewportTop = 0;
        stickyTail = true;
        append(text);
    };

    // ---- motions -------------------------------------------------------------

    const moveBy = (drow: number, dcol: number, n: number): void => {
        if (drow !== 0) cursor.row += drow * n;
        if (dcol !== 0) cursor.col += dcol * n;
        clampCursor();
    };

    const moveToLineStart = (): void => { cursor.col = 0; };
    const moveToFirstNonBlank = (): void => {
        const line = lines[cursor.row] ?? '';
        const m = line.match(/^\s*/);
        cursor.col = m ? m[0].length : 0;
    };
    const moveToLineEnd = (): void => {
        cursor.col = Math.max(0, lineLen(cursor.row) - 1);
    };

    const moveWordForward = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            const here = (lines[r] ?? '')[c];
            // Skip current run
            if (here !== undefined && isWord(here)) {
                while (c < lineLen(r) && isWord((lines[r] ?? '')[c])) c++;
            } else {
                while (c < lineLen(r) && !isWord((lines[r] ?? '')[c]) && (lines[r] ?? '')[c] !== ' ') c++;
            }
            // Skip whitespace + line wraps
            while (true) {
                if (c >= lineLen(r)) {
                    if (r >= lines.length - 1) { c = lineLen(r); break; }
                    r++; c = 0; continue;
                }
                if ((lines[r] ?? '')[c] === ' ') { c++; continue; }
                break;
            }
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const moveWordBackward = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            // Step back one
            if (c > 0) c--; else if (r > 0) { r--; c = lineLen(r); }
            // Skip whitespace
            while (true) {
                if ((lines[r] ?? '')[c] === ' ') {
                    if (c > 0) c--; else if (r > 0) { r--; c = lineLen(r); } else break;
                    continue;
                }
                break;
            }
            // Move to start of run
            const cls = isWord((lines[r] ?? '')[c] ?? '');
            while (c > 0 && isWord((lines[r] ?? '')[c - 1] ?? '') === cls && (lines[r] ?? '')[c - 1] !== ' ') c--;
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const moveWordEnd = (n: number, isWord: (ch: string) => boolean): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row, c = cursor.col;
            c++;
            // Skip whitespace
            while (true) {
                if (c >= lineLen(r)) {
                    if (r >= lines.length - 1) { c = lineLen(r) - 1; break; }
                    r++; c = 0; continue;
                }
                if ((lines[r] ?? '')[c] === ' ') { c++; continue; }
                break;
            }
            // Walk to last char of run
            const cls = isWord((lines[r] ?? '')[c] ?? '');
            while (c + 1 < lineLen(r) && isWord((lines[r] ?? '')[c + 1] ?? '') === cls && (lines[r] ?? '')[c + 1] !== ' ') c++;
            cursor.row = r; cursor.col = c;
        }
        clampCursor();
    };

    const moveParagraphForward = (n: number): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row + 1;
            while (r < lines.length && (lines[r] ?? '').trim() !== '') r++;
            while (r < lines.length && (lines[r] ?? '').trim() === '') r++;
            if (r >= lines.length) r = lines.length - 1;
            cursor.row = r; cursor.col = 0;
        }
    };

    const moveParagraphBackward = (n: number): void => {
        for (let i = 0; i < n; i++) {
            let r = cursor.row - 1;
            while (r > 0 && (lines[r] ?? '').trim() === '') r--;
            while (r > 0 && (lines[r] ?? '').trim() !== '') r--;
            if (r < 0) r = 0;
            cursor.row = r; cursor.col = 0;
        }
    };

    const findInLine = (ch: string, dir: 1 | -1, type: 'f' | 't', n: number): void => {
        const line = lines[cursor.row] ?? '';
        let c = cursor.col;
        for (let i = 0; i < n; i++) {
            if (dir === 1) {
                let pos = line.indexOf(ch, c + 1);
                if (pos < 0) return;
                c = type === 't' ? pos - 1 : pos;
            } else {
                let pos = line.lastIndexOf(ch, c - 1);
                if (pos < 0) return;
                c = type === 't' ? pos + 1 : pos;
            }
        }
        cursor.col = c;
        clampCursor();
    };

    const computeSearchHits = (li: number, pat: string): number[] => {
        if (!pat) return [];
        const raw = lines[li] ?? '';
        const out: number[] = [];
        let idx = 0;
        const step = Math.max(1, pat.length);
        while (idx <= raw.length) {
            const i = raw.indexOf(pat, idx);
            if (i < 0) break;
            out.push(i);
            idx = i + step;
        }

        return out;
    };

    const activeSearchPattern = (): string => {
        if (searchInput && searchInput.length > 0) return searchInput;
        if (lastSearch && lastSearch.pattern) return lastSearch.pattern;

        return '';
    };


    const searchAll = (pat: string, dir: 1 | -1): boolean => {
        if (!pat) return false;
        const total = lines.length;
        for (let off = 1; off <= total; off++) {
            const r = (cursor.row + dir * off + total * 100) % total;
            const startCol = (off === 1 && r === cursor.row) ? cursor.col + dir : (dir === 1 ? 0 : (lineLen(r) - 1));
            const line = lines[r] ?? '';
            const idx = dir === 1 ? line.indexOf(pat, Math.max(0, startCol)) : line.lastIndexOf(pat, Math.max(0, startCol));
            if (idx >= 0) {
                cursor.row = r; cursor.col = idx;
                clampCursor();

                return true;
            }
        }

        return false;
    };

    const scrollHalf = (dir: 1 | -1): void => {
        const half = Math.max(1, Math.floor(visibleHeight() / 2));
        cursor.row += dir * half;
        viewportTop += dir * half;
        clampCursor();
    };

    const scrollFull = (dir: 1 | -1): void => {
        const vh = visibleHeight();
        cursor.row += dir * vh;
        viewportTop += dir * vh;
        clampCursor();
    };

    const centerCursor = (where: 'middle' | 'top' | 'bottom'): void => {
        const vh = visibleHeight();
        if (where === 'middle') viewportTop = cursor.row - Math.floor(vh / 2);
        else if (where === 'top') viewportTop = cursor.row;
        else viewportTop = cursor.row - vh + 1;
    };

    const moveScreenTop = (): void => { cursor.row = viewportTop; cursor.col = 0; };
    const moveScreenMid = (): void => { cursor.row = viewportTop + Math.floor(visibleHeight() / 2); cursor.col = 0; clampCursor(); };
    const moveScreenBot = (): void => { cursor.row = viewportTop + visibleHeight() - 1; cursor.col = 0; clampCursor(); };

    // ---- key dispatch --------------------------------------------------------

    const handleSearchKey = (ch: string | undefined, key: { name?: string }): boolean => {
        if (searchInput === null) return false;
        if (key.name === 'enter' || key.name === 'return') {
            const pat = searchInput;
            searchInput = null;
            if (pat) {
                lastSearch = { pattern: pat, dir: 1 };
                if (opts.onSearch) opts.onSearch(pat);
                searchAll(pat, 1);
            }
            render();

            return true;
        }
        if (key.name === 'escape') { searchInput = null; render();

 return true; }
        if (key.name === 'backspace') { searchInput = searchInput.slice(0, -1); render();

 return true; }
        if (ch && ch.length === 1 && ch >= ' ') {
            searchInput += ch;
            render();

            return true;
        }

        return false;
    };

    const onKey = (ch: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean }): void => {
        // Search prompt has top priority.
        if (handleSearchKey(ch, key)) return;

        const name = key.name ?? '';
        const count = pendingCount > 0 ? pendingCount : 1;

        // Numeric prefix (but not leading 0 — that's start-of-line).
        if (ch && /^[0-9]$/.test(ch) && !(ch === '0' && pendingCount === 0)) {
            pendingCount = pendingCount * 10 + Number(ch);

            return;
        }

        // Pending compound op (g, z, f/F/t/T)
        if (pendingOp === 'g') {
            pendingOp = null;
            if (name === 'g' || ch === 'g') { cursor.row = pendingCount > 0 ? pendingCount - 1 : 0; cursor.col = 0; clampCursor(); }
            stickyTail = false; pendingCount = 0;
            render();

            return;
        }
        if (pendingOp === 'z') {
            pendingOp = null;
            if (ch === 'z') centerCursor('middle');
            else if (ch === 't') centerCursor('top');
            else if (ch === 'b') centerCursor('bottom');
            stickyTail = false; pendingCount = 0;
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

        // Mode-entry / mode-exit
        if (name === 'escape') {
            if (mode !== 'NORMAL') { fireMode('NORMAL'); }
            pendingCount = 0; pendingOp = null;
            lastSearch = null;
            render();

            return;
        }

        // Plain motions (work in NORMAL, VISUAL, V-LINE)
        if (key.ctrl) {
            if (name === 'd') { scrollHalf(1); stickyTail = isAtTail(); render();

 return; }
            if (name === 'u') { scrollHalf(-1); stickyTail = false; render();

 return; }
            if (name === 'f') { scrollFull(1); stickyTail = isAtTail(); render();

 return; }
            if (name === 'b') { scrollFull(-1); stickyTail = false; render();

 return; }
        }

        switch (ch) {
            case 'h': moveBy(0, -1, count); stickyTail = false; render();

 return;
            case 'l': moveBy(0, 1, count); stickyTail = false; render();

 return;
            case 'j': moveBy(1, 0, count); stickyTail = isAtTail(); render();

 return;
            case 'k': moveBy(-1, 0, count); stickyTail = false; render();

 return;
            case '0': moveToLineStart(); render();

 return;
            case '^': moveToFirstNonBlank(); render();

 return;
            case '$': moveToLineEnd(); render();

 return;
            case 'w': moveWordForward(count, isWordChar); stickyTail = isAtTail(); render();

 return;
            case 'W': moveWordForward(count, isWORDChar); stickyTail = isAtTail(); render();

 return;
            case 'b': moveWordBackward(count, isWordChar); stickyTail = false; render();

 return;
            case 'B': moveWordBackward(count, isWORDChar); stickyTail = false; render();

 return;
            case 'e': moveWordEnd(count, isWordChar); stickyTail = isAtTail(); render();

 return;
            case 'E': moveWordEnd(count, isWORDChar); stickyTail = isAtTail(); render();

 return;
            case '{': moveParagraphBackward(count); stickyTail = false; render();

 return;
            case '}': moveParagraphForward(count); stickyTail = isAtTail(); render();

 return;
            case '[': moveBy(-15, 0, count); stickyTail = false; render();

 return;
            case ']': moveBy(15, 0, count); stickyTail = isAtTail(); render();

 return;
            case 'H': moveScreenTop(); render();

 return;
            case 'M': moveScreenMid(); render();

 return;
            case 'L': moveScreenBot(); render();

 return;
            case 'g': pendingOp = 'g';

 return;
            case 'G': {
                if (pendingCount > 0) { cursor.row = pendingCount - 1; cursor.col = 0; clampCursor(); stickyTail = false; }
                else { cursor.row = lines.length - 1; cursor.col = 0; clampCursor(); stickyTail = true; }
                pendingCount = 0;
                render();

                return;
            }
            case 'z': pendingOp = 'z';

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
            case '/': searchInput = ''; render();

 return;
            case 'n': if (lastSearch) { searchAll(lastSearch.pattern, lastSearch.dir); stickyTail = false; render(); }

 return;
            case 'N': if (lastSearch) { searchAll(lastSearch.pattern, (-lastSearch.dir) as 1 | -1); stickyTail = false; render(); }

 return;
            case 'v':
                if (mode === 'VISUAL') { fireMode('NORMAL'); }
                else { anchor = { ...cursor }; fireMode('VISUAL'); }
                render();

                return;
            case 'V':
                if (mode === 'V-LINE') { fireMode('NORMAL'); }
                else { anchor = { ...cursor }; fireMode('V-LINE'); }
                render();

                return;
            case 'y': {
                const text = selectedText();
                copyViaOsc52(text);
                if (opts.onYank) opts.onYank(text.length);
                if (mode !== 'NORMAL') fireMode('NORMAL');
                render();

                return;
            }
            case 'G': // duplicate guard, handled above
                return;
        }

        // Arrow keys mirror hjkl
        if (name === 'up') { moveBy(-1, 0, count); stickyTail = false; render();

 return; }
        if (name === 'down') { moveBy(1, 0, count); stickyTail = isAtTail(); render();

 return; }
        if (name === 'left') { moveBy(0, -1, count); stickyTail = false; render();

 return; }
        if (name === 'right') { moveBy(0, 1, count); stickyTail = false; render();

 return; }
        if (name === 'pageup') { scrollFull(-1); stickyTail = false; render();

 return; }
        if (name === 'pagedown') { scrollFull(1); stickyTail = isAtTail(); render();

 return; }
        if (name === 'home') { moveToLineStart(); render();

 return; }
        if (name === 'end') { moveToLineEnd(); render();

 return; }

        // Anything else: clear count and ignore.
        pendingCount = 0;
    };

    el.on('keypress', (ch, key) => {
        // Ignore keypresses while the pane is not focused (blessed delivers
        // them everywhere otherwise).
        const screen = (el as unknown as { screen?: { focused?: blessed.Widgets.BlessedElement } }).screen;
        if (screen && screen.focused !== el) return;
        try { onKey(ch as string | undefined, key as { name?: string; ctrl?: boolean; shift?: boolean }); } catch { /* ignore */ }
    });

    // Mouse wheel scroll
    el.on('wheelup', () => { scrollHalf(-1); stickyTail = false; render(); });
    el.on('wheeldown', () => { scrollHalf(1); stickyTail = isAtTail(); render(); });

    // Re-render on resize so viewport stays sane.
    const screen = (el as unknown as { screen?: blessed.Widgets.Screen }).screen;
    if (screen) screen.on('resize', () => render());

    render();

    const setLineStyled = (row: number, styled: string, wrapStyled?: boolean): void => {
        if (row < 0 || row >= styledLines.length) return;
        styledLines[row] = stripWideChars(styled);
        wrapByStyled[row] = !!wrapStyled;
        render();
    };

    const replaceLastLines = (
        count: number,
        batch: { plain: string; styled: string; wrapStyled?: boolean }[],
    ): void => {
        // Tail is at lines[length-1]; completed rows above it are
        // lines[length-1-count .. length-2]. Clamp count.
        const tailIdx = lines.length - 1;
        const drop = Math.min(Math.max(0, count), tailIdx);
        if (drop > 0) {
            lines.splice(tailIdx - drop, drop);
            styledLines.splice(tailIdx - drop, drop);
            wrapByStyled.splice(tailIdx - drop, drop);
        }
        // Insert batch BEFORE the (preserved) tail slot.
        const insertAt = lines.length - 1;
        for (let i = 0; i < batch.length; i++) {
            const p = stripWideChars(sanitizeForBlessed(batch[i].plain)).replace(/\t/g, TAB_REPLACEMENT);
            lines.splice(insertAt + i, 0, p);
            styledLines.splice(insertAt + i, 0, stripWideChars(batch[i].styled || ''));
            wrapByStyled.splice(insertAt + i, 0, !!batch[i].wrapStyled);
        }
        trim();
        render();
    };

    const setTail = (plain: string, styled: string): void => {
        const sanitized = stripWideChars(sanitizeForBlessed(plain)).replace(/\t/g, TAB_REPLACEMENT);
        pendingTail = sanitized;
        const li = lines.length - 1;
        lines[li] = sanitized;
        styledLines[li] = stripWideChars(styled);
        render();
    };

    return {
        el,
        append,
        set,
        lineCount: () => lines.length,
        setLineStyled,
        replaceLastLines,
        setTail,
        mode: () => mode,
        jumpToTail: () => { stickyTail = true; render(); },
        setTailLocked: (locked: boolean) => {
            tailLocked = locked;
            if (locked && !stickyTail) {
                stickyTail = true;
                render();
            }
        },
        setFocused: (f) => {
            if (f === focused) return;
            focused = f;
            render();
        },
        viewportWidth: () => visibleWidth(),
    };
}
