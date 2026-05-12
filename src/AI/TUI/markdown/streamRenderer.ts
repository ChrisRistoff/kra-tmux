import { highlight, supportsLanguage } from 'cli-highlight';
import { renderInline as renderInlineLegacy } from './inline';
import { renderInlineMarkdown } from './markedInline';
import { bold, dim, gray, palette } from './ansi';

// `marked.parseInline` is the preferred path for inline markdown so we
// pick up the long tail of formatting (nested emphasis, autolinks,
// HTML-entity unescaping, etc.) for free instead of re-implementing it.
// We keep the legacy regex-based renderer as a fallback for the rare
// case where marked corrupts our content (e.g. our role-banner /
// thinking-block lines, which we route through dedicated renderers).
const renderInline = (raw: string): string => {
    const out = renderInlineMarkdown(raw);
    if (out && out.length > 0) return out;

    return renderInlineLegacy(raw);
};

// Line-oriented streaming markdown -> ANSI renderer.
//
// The renderer is fed arbitrary text chunks via `feed(chunk)` and returns
// the set of NEWLY FINALIZED LINES (i.e. lines terminated by `\n`) plus an
// updated `tail` representing the in-progress last line. The caller is
// responsible for placing those lines into a transcript buffer.
//
// Spirit-of fidelity: we cover the cases users see in chat output:
//   - ATX headings (#, ##, ###, ####)
//   - Fenced code blocks with optional language (```lang ... ```)
//   - Unordered list items (- / * / +)
//   - Ordered list items (1. 2. ...)
//   - Blockquotes (>)
//   - Horizontal rules (---, ***, ___)
//   - Inline: code, bold, italic, strike, links
//
// Code-fence content is buffered until the closing fence so we can
// syntax-highlight the whole block at once. While buffering, the in-progress
// code lines render as dim gray (spirit-of "this is code, not styled prose").

export interface RenderedLine {
    plain: string;   // unsanitized plain text (what the transcript stores)
    styled: string;  // ANSI-colored rendering for the styled line buffer
    /** When set, the host should overwrite the previous N transcript rows
     *  with this line's batch instead of appending fresh rows. Used by
     *  code-fence closure to swap provisional dim rows for highlighted
     *  ones in place. The flag is set on the FIRST line of the batch only;
     *  subsequent lines in the same batch are normal appends after the
     *  in-place replacement. */
    replacesPrevious?: number;
    /** When true, the transcript pane should soft-wrap the *styled*
     *  output by its visible (ANSI-stripped) width instead of by the
     *  `plain` length. Used by the table renderer where `plain` is the
     *  short raw markdown source (e.g. `| a | b |`) but `styled` is the
     *  much wider box-drawn rendering. Without this hint the box rows
     *  silently truncate at the right edge of the viewport. Banners do
     *  NOT set this — their styled bg-pad would explode into many rows. */
    wrapStyled?: boolean;
}

export interface FeedResult {
    /** Lines that just became complete (terminated by `\n`). */
    completed: RenderedLine[];
    /** The current in-progress tail line (no trailing `\n`). May be empty. */
    tail: RenderedLine;
}

interface CodeBlockState {
    lang: string | null;
    rawLines: string[];
    fenceMarker: string; // ``` or ~~~ that opened it
}

type TableAlign = 'left' | 'right' | 'center';

interface TableState {
    /** Source lines emitted as provisional dim rows, replaced on finalize. */
    rawLines: string[];
    /** Parsed cell content per row (separator row included as empty cells). */
    rows: string[][];
    /** Index into `rows` of the alignment / separator row, if any. */
    sepIndex: number;
    /** Column alignments parsed from the separator row; `left` if no sep. */
    aligns: TableAlign[];
}

const HEADING_COLORS = [
    (s: string): string => bold(palette.h1(s)), // h1
    (s: string): string => bold(palette.h2(s)), // h2
    (s: string): string => bold(palette.h3(s)), // h3
    (s: string): string => bold(palette.h4(s)), // h4
    (s: string): string => bold(palette.h5(s)), // h5
    (s: string): string => bold(palette.h6(s)), // h6
];

export interface StreamMarkdownRenderer {
    feed: (chunk: string) => FeedResult;
    /** Forcibly close the renderer and flush any tail-line as a completed
     *  line. Useful at end-of-message. */
    flush: () => RenderedLine[];
    /** Reset all state (start a new message). */
    reset: () => void;
}

export interface StreamMarkdownRendererOpts {
    /** Returns the current viewport width in columns. Used to fit
     *  wide tables: column widths are budgeted against this number
     *  and over-long cells are word-wrapped onto extra row lines so
     *  the table never overflows the right edge. Defaults to 120 if
     *  omitted (caller-less unit tests). */
    getViewportWidth?: () => number;
}

export function createStreamMarkdownRenderer(opts: StreamMarkdownRendererOpts = {}): StreamMarkdownRenderer {
    const viewportWidth = (): number => {
        const w = opts.getViewportWidth ? opts.getViewportWidth() : 120;

        return Math.max(20, w);
    };
    let pending = ''; // bytes after the last `\n` we've seen
    let codeBlock: CodeBlockState | null = null;
    // Buffered table state. We accumulate every contiguous `| ... |` line
    // (header + alignment row + body) and emit a provisional dim line for
    // each. When the table closes (blank line, non-table line, or stream
    // end) we flush it as a properly-aligned, box-drawn rendering that
    // replaces the provisional rows in-place.
    let tableBuffer: TableState | null = null;

    // Detect the conversation role headers emitted by chatHeaders.ts
    // (`### 👤 USER PROMPT · ts` and `### 🤖 ASSISTANT · model · ts`).
    // Accepts both `##` and `###` so older chat files (which used `##`)
    // still get the banner treatment when re-opened. The leading emoji
    // is stripped downstream by stripWideChars before it ever reaches
    // blessed (it triggers the fullUnicode cell-grid bleed bug), so the
    // regex tolerates either form.
    const ROLE_HEADER_RE = /^#{2,3}\s+(?:\S+\s+)?(USER PROMPT|ASSISTANT|INVESTIGATOR-WEB|INVESTIGATOR|EXECUTOR)\b\s*(\(draft\))?\s*(?:·\s*(.*))?$/u;

    // Render a full-row inverse banner for USER/ASSISTANT headers. We
    // pre-fill a long run of spaces inside the SGR bg so that
    // `truncateAndPad` can slice mid-pad and still leave the visible
    // cells coloured (the trailing RESET it appends only kicks in AFTER
    // we've already emitted enough columns).
    // Tokyo Night-flavoured banners for each conversation role. Muted,
    // low-saturation backgrounds with soft accent foregrounds so the
    // eye picks up the role at a glance without straining.
    //   USER             → muted slate bg + fg-dark   (#9aa5ce)
    //   ASSISTANT        → muted navy  bg + cyan       (#7dcfff)
    //   INVESTIGATOR     → muted teal  bg + green      (#9ece6a)
    //   INVESTIGATOR-WEB → muted plum  bg + magenta    (#bb9af7)
    //   EXECUTOR         → muted ember bg + amber      (#e0af68)
    const ROLE_BANNER_PALETTES: Record<string, { bg: string; fg: string; label: string; emoji: string }> = {
        USER: { bg: '48;2;37;41;56', fg: '38;2;154;165;206', label: 'USER', emoji: '👤' },
        ASSISTANT: { bg: '48;2;31;45;61', fg: '38;2;125;207;255', label: 'ASSISTANT', emoji: '🤖' },
        INVESTIGATOR: { bg: '48;2;30;48;42', fg: '38;2;158;206;106', label: 'INVESTIGATOR', emoji: '🔍' },
        'INVESTIGATOR-WEB': { bg: '48;2;46;38;58', fg: '38;2;187;154;247', label: 'INVESTIGATOR-WEB', emoji: '🌐' },
        EXECUTOR: { bg: '48;2;52;42;30', fg: '38;2;224;175;104', label: 'EXECUTOR', emoji: '⚙' },
    };

    // Render a multi-row banner for the role headers above. We emit
    // THREE visible rows (top rule + label + bottom rule), all painted
    // with the role's bg colour, so the entry is visually ~3x the
    // height of a normal line — distinctive without resorting to true
    // ASCII-art fonts (which would clutter the chat). We pre-fill a
    // long run of spaces inside each SGR bg row so `truncateAndPad`
    // can slice mid-pad and still leave the visible cells coloured
    // (the trailing RESET it appends only kicks in AFTER we've already
    // emitted enough columns).
    const renderRoleBanner = (role: string, draft: boolean, meta: string): RenderedLine[] => {
        const key = /^USER/i.test(role) ? 'USER' : role.toUpperCase();
        const pal = ROLE_BANNER_PALETTES[key] ?? ROLE_BANNER_PALETTES['ASSISTANT'];
        const palBg = `\x1b[${pal.bg}m\x1b[${pal.fg}m`;
        const baseLabel = pal.label;
        const label = draft ? `${baseLabel} (draft)` : baseLabel;
        // Lead with the role's emoji — the five banner emojis are
        // exempted from the wide-char strip in stripWide.ts so they
        // actually render. Two trailing spaces compensate for the
        // double-width emoji cell so the body alignment looks right.
        // Build the body using NO-BREAK SPACES (\u00A0) between visible
        // tokens so wrapAnsiLine treats the entire label as a single
        // unbreakable unit — if it word-wrapped on a regular space
        // the trailing bg-pad would land on a NEW row, leaving the
        // banner row only as wide as the text ended ("grey ends where
        // text ends" bug). The plain mirror keeps real spaces for the
        // accessibility/copy path where width doesn't matter.
        const NBSP = '\u00a0';
        const body = meta
            ? `${pal.emoji}${NBSP}${NBSP}${label}${NBSP}${NBSP}·${NBSP}${NBSP}${meta}`
            : `${pal.emoji}${NBSP}${NBSP}${label}`;
        const pad = ' '.repeat(500);
        // Top + bottom rule rows are pure bg (no text) so the eye
        // perceives a solid colour band ~3 rows tall around the label.
        const ruleStyled = `${palBg}${pad}`;
        const labelStyled = `${palBg} ${body} ${pad}`;
        const plainBody = `${pal.emoji}  ${label}${meta ? '  ·  ' + meta : ''}`;

        return [
            { plain: '', styled: ruleStyled },
            { plain: plainBody, styled: labelStyled },
            { plain: '', styled: ruleStyled },
        ];
    };

    const renderHeading = (raw: string): RenderedLine => {
        // Role-banner case is handled at the processCompletedLine level
        // (it can emit multiple rows). This branch is retained as a
        // safety net for any caller that bypasses processCompletedLine
        // and goes through renderProseLine directly — we collapse the
        // 3-row banner down to its label row so the styling is preserved.
        const role = ROLE_HEADER_RE.exec(raw);
        if (role) {
            const rows = renderRoleBanner(role[1], !!role[2], (role[3] ?? '').trim());
            return rows[1] ?? rows[0];
        }
        const m = /^(#{1,6})\s+(.*)$/.exec(raw);
        if (!m) return { plain: raw, styled: renderInline(raw) };
        const level = m[1].length;
        const colorize = HEADING_COLORS[Math.min(level, HEADING_COLORS.length) - 1];
        const inner = renderInline(m[2]);

        return { plain: raw, styled: colorize(inner) };
    };

    const renderListItem = (raw: string): RenderedLine | null => {
        // Unordered:  - foo  /  * foo  /  + foo
        const u = /^(\s*)([-*+])\s+(.*)$/.exec(raw);
        if (u) {
            const indent = u[1];
            const depth = Math.min(2, Math.floor(indent.length / 2));
            const bullets = ['●', '○', '◇'];
            const bullet = bullets[depth];

            return {
                plain: `${indent}${bullet} ${u[3]}`,
                styled: `${indent}${palette.bullet(bullet)} ${renderInline(u[3])}`,
            };
        }
        // Ordered: 1. foo
        const o = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
        if (o) {
            return {
                plain: raw,
                styled: `${o[1]}${palette.bullet(`${o[2]}.`)} ${renderInline(o[3])}`,
            };
        }

        return null;
    };

    const renderBlockquote = (raw: string): RenderedLine | null => {
        const m = /^>\s?(.*)$/.exec(raw);
        if (!m) return null;

        return {
            plain: raw,
            styled: `${palette.bar('┃')} ${dim(renderInline(m[1]))}`,
        };
    };

    const isHorizontalRule = (raw: string): boolean =>
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw);

    // Detect a markdown table row: starts and ends with `|` (after trim),
    // contains at least one interior `|`. e.g. `| col1 | col2 |`.
    const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
    // The alignment / separator row beneath a table header, e.g.
    // `| --- | :---: | ---: |`.
    const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/;

    // ---------- Table parsing & rendering --------------------------------

    const parseCells = (raw: string): string[] => {
        const trimmed = raw.trim();
        const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');

        return inner.split('|').map((c) => c.trim());
    };

    const parseAligns = (sepCells: string[]): TableAlign[] => sepCells.map((c) => {
        const trimmed = c.trim();
        const left = trimmed.startsWith(':');
        const right = trimmed.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';

        return 'left';
    });

    /** Strip ANSI escapes for visible-width measurement. */
    const visibleLen = (s: string): number =>
        s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').length;

    /** Pad a styled cell to `width` visible columns according to `align`. */
    const padCell = (styled: string, width: number, align: TableAlign): string => {
        const pad = Math.max(0, width - visibleLen(styled));
        if (pad === 0) return styled;
        if (align === 'right') return ' '.repeat(pad) + styled;
        if (align === 'center') {
            const l = Math.floor(pad / 2);

            return ' '.repeat(l) + styled + ' '.repeat(pad - l);
        }

        return styled + ' '.repeat(pad);
    };

    /** Word-wrap a plain string to `width` columns. Splits on whitespace
     *  but falls back to hard-cut for tokens longer than the cell width. */
    const wrapPlain = (s: string, width: number): string[] => {
        if (width <= 0) return [s];
        const out: string[] = [];
        const words = s.split(/(\s+)/);
        let line = '';
        const flush = (): void => { if (line.length > 0) { out.push(line); line = ''; } };
        for (const tok of words) {
            if (tok.length === 0) continue;
            if (line.length + tok.length <= width) {
                line += tok;
                continue;
            }
            // Token doesn't fit on current line.
            if (/^\s+$/.test(tok)) {
                flush();
                continue;
            }
            if (line.length > 0) flush();
            // Hard-cut tokens longer than the column.
            let rest = tok;
            while (rest.length > width) {
                out.push(rest.slice(0, width));
                rest = rest.slice(width);
            }
            line = rest;
        }
        flush();

        return out.length > 0 ? out : [''];
    };

    /** Render the buffered table as a sequence of styled lines that replace
     *  the provisional rows already in the transcript. */
    const finalizeTable = (state: TableState): RenderedLine[] => {
        const { rows, sepIndex, aligns, rawLines } = state;
        // Body rows = everything except the separator (if any).
        const dataRows = sepIndex >= 0
            ? rows.filter((_, i) => i !== sepIndex)
            : rows;
        if (dataRows.length === 0) return [];
        const headerRow = dataRows[0];
        const bodyRows = dataRows.slice(1);
        const colCount = Math.max(...dataRows.map((r) => r.length));
        // Normalise widths: pad short rows so column count is consistent.
        for (const r of dataRows) {
            while (r.length < colCount) r.push('');
        }
        // Pad aligns to colCount (default left).
        const finalAligns: TableAlign[] = [];
        for (let i = 0; i < colCount; i++) finalAligns.push(aligns[i] ?? 'left');
        // Compute column widths from PLAIN cell text (so styling doesn't
        // throw the math off).
        const widths: number[] = new Array(colCount).fill(0);
        for (const row of dataRows) {
            for (let c = 0; c < colCount; c++) {
                if (row[c].length > widths[c]) widths[c] = row[c].length;
            }
        }
        // Minimum cell width 3 so very short headers still get a visible cell.
        for (let c = 0; c < colCount; c++) widths[c] = Math.max(3, widths[c]);

        // Fit the table to the current viewport: total decoration width
        // is `"│ "` + `" │"` + `" │ "` between cells. Anything beyond
        // viewport vw triggers proportional shrink (min 3 per column);
        // long cells then word-wrap onto extra row lines so the table
        // stays inside the box instead of overflowing the right edge.
        const decoration = 4 + 3 * Math.max(0, colCount - 1);
        const vw = viewportWidth();
        const availContent = Math.max(colCount * 3, vw - decoration);
        const naturalSum = widths.reduce((a, b) => a + b, 0);
        if (naturalSum > availContent) {
            const scaled = widths.map((w) => Math.max(3, Math.floor((w * availContent) / naturalSum)));
            // Distribute leftover columns one-by-one to widest naturals
            // first so rounding loss doesn't accumulate on a single cell.
            let used = scaled.reduce((a, b) => a + b, 0);
            const order = widths
                .map((w, i) => ({ w, i }))
                .sort((a, b) => b.w - a.w)
                .map((x) => x.i);
            let k = 0;
            while (used < availContent && k < order.length * 4) {
                scaled[order[k % order.length]] += 1;
                used += 1;
                k++;
            }
            for (let c = 0; c < colCount; c++) widths[c] = scaled[c];
        }

        const border = palette.tableBorder;
        const top    = border('┌─' + widths.map((w) => '─'.repeat(w)).join('─┬─') + '─┐');
        const mid    = border('├─' + widths.map((w) => '─'.repeat(w)).join('─┼─') + '─┤');
        const bottom = border('└─' + widths.map((w) => '─'.repeat(w)).join('─┴─') + '─┘');
        const colSep = border(' │ ');
        const edge   = border('│ ');
        const rEdge  = border(' │');

        // Render one logical data row as 1+ visual sub-rows: each cell
        // is word-wrapped to its (possibly shrunk) column width, and the
        // row's height = max line-count across cells. Empty sub-rows get
        // blank cells so the box edges stay aligned.
        const renderRowLines = (cells: string[], isHeader: boolean): string[] => {
            const wrapped: string[][] = cells.map((c, i) => wrapPlain(c, widths[i]));
            const rowHeight = Math.max(1, ...wrapped.map((w) => w.length));
            const lines: string[] = [];
            for (let r = 0; r < rowHeight; r++) {
                const styled = wrapped.map((cellLines, i) => {
                    const piece = cellLines[r] ?? '';
                    const inner = renderInline(piece);
                    const coloured = isHeader
                        ? bold(palette.tableHeader(inner))
                        : palette.tableCell(inner);

                    return padCell(coloured, widths[i], finalAligns[i]);
                });
                lines.push(edge + styled.join(colSep) + rEdge);
            }

            return lines;
        };

        const out: RenderedLine[] = [];
        out.push({ plain: '', styled: top });
        for (const ln of renderRowLines(headerRow, true)) {
            out.push({ plain: rawLines[0] ?? '', styled: ln });
        }
        out.push({ plain: '', styled: mid });
        for (let i = 0; i < bodyRows.length; i++) {
            // Map body row back to its original raw line so the plain-text
            // transcript still has the user's source for yank/copy.
            const rawIdx = sepIndex >= 0
                ? (i >= sepIndex ? i + 2 : i + 1)
                : i + 1;
            for (const ln of renderRowLines(bodyRows[i], false)) {
                out.push({ plain: rawLines[rawIdx] ?? '', styled: ln });
            }
        }
        out.push({ plain: '', styled: bottom });

        // Replace the N provisional dim rows that were emitted while the
        // table was streaming. The first emitted row carries the count.
        out[0].replacesPrevious = rawLines.length;

        return out;
    };

    const provisionalTableRow = (raw: string): RenderedLine => ({
        plain: raw,
        styled: dim(palette.tableBorder(raw)),
    });

    // Tool-call lines emitted by `formatToolLine` look like
    //   `✓ deep_search(...)`  /  `✗ web_fetch(url)`
    // (single backtick wrap). Make them visually distinct so the user
    // sees "the agent did a thing" at a glance instead of having them
    // blend in as inline-code prose.
    const TOOL_LINE_RE = /^`([✓✗])\s+(.+)`$/;

    const renderToolLine = (raw: string): RenderedLine | null => {
        const m = TOOL_LINE_RE.exec(raw);
        if (!m) return null;
        const ok = m[1] === '✓';
        // 24-bit truecolor; same colour family as the role banners.
        //   OK   → dark forest bg + Tokyo Night green fg
        //   ERR  → dark crimson bg + Tokyo Night red fg
        // Tokyo Night-flavoured tool banners.
        //   OK   → muted amber bg  + Tokyo Night yellow fg (#e0af68)
        //   ERR  → muted maroon bg + Tokyo Night red1   fg (#db4b4b)
        const palBg = ok
            ? '\x1b[48;2;46;40;32m\x1b[38;2;224;175;104m'
            : '\x1b[48;2;42;31;34m\x1b[38;2;219;75;75m';
        const sigil = ok ? '✓' : '✗';
        const inner = ` │ ${sigil}  ${m[2]} `;
        const TOOL_BANNER_COLS = 70;
        const padCount = Math.max(0, TOOL_BANNER_COLS - inner.length);
        // No bold — keeps tool banners visually consistent with the
        // role banners and avoids the harsh edges that bold-on-tinted-bg
        // produces in many terminal fonts.
        const styled = `${palBg}${inner}${' '.repeat(padCount)}\x1b[0m`;

        return { plain: inner.trimEnd(), styled };
    };

    const renderProseLine = (raw: string): RenderedLine => {
        if (raw.length === 0) return { plain: '', styled: '' };
        if (isHorizontalRule(raw)) {
            return { plain: raw, styled: palette.rule('─'.repeat(40)) };
        }
        const tool = renderToolLine(raw);
        if (tool) return tool;
        if (/^#{1,6}\s+/.test(raw)) return renderHeading(raw);
        const li = renderListItem(raw);
        if (li) return li;
        const bq = renderBlockquote(raw);
        if (bq) return bq;

        return { plain: raw, styled: renderInline(raw) };
    };

    const isThinkingLang = (lang: string | null): boolean =>
        lang !== null && /^(thinking|reasoning|cot|think)$/i.test(lang);

    const renderCodeFenceClose = (cb: CodeBlockState): RenderedLine[] => {
        // Thinking / chain-of-thought blocks render as ALL-blue italic prose
        // (no syntax highlighting) so they read distinctly from real code.
        // Pre-wrap each raw line to viewport width MINUS the `│ ` prefix so
        // the left border survives on every visual row instead of being
        // dropped on word-wrapped continuations.
        if (isThinkingLang(cb.lang)) {
            const vw = viewportWidth();
            const innerWidth = Math.max(10, vw - 2);
            const out: RenderedLine[] = [];
            for (const raw of cb.rawLines) {
                const wrapped = raw.length === 0 ? [''] : wrapPlain(raw, innerWidth);
                for (const w of wrapped) {
                    out.push({
                        plain: w,
                        styled: palette.thinkingBar('│ ') + bold(palette.thinkingFg(w)),
                    });
                }
            }
            if (out.length > 0) out[0].replacesPrevious = cb.rawLines.length;

            return out;
        }

        const src = cb.rawLines.join('\n');
        let highlighted: string;
        if (cb.lang && supportsLanguage(cb.lang)) {
            try {
                highlighted = highlight(src, { language: cb.lang, ignoreIllegals: true });
            } catch {
                highlighted = src;
            }
        } else {
            highlighted = highlight(src, { ignoreIllegals: true });
        }
        const styledLines = highlighted.split('\n');
        const out: RenderedLine[] = cb.rawLines.map((raw, i) => ({
            plain: raw,
            styled: palette.fenceBar('│ ') + (styledLines[i] ?? raw),
        }));
        // First line replaces the N provisional rows that were emitted
        // while the fence was open (one per raw line).
        if (out.length > 0) out[0].replacesPrevious = cb.rawLines.length;

        return out;
    };

    const consumeLine = (raw: string): RenderedLine[] => {
        // Inside a buffered table? Decide whether to extend or close it.
        if (tableBuffer) {
            if (TABLE_SEP_RE.test(raw)) {
                tableBuffer.rawLines.push(raw);
                tableBuffer.rows.push(parseCells(raw));
                tableBuffer.sepIndex = tableBuffer.rows.length - 1;
                tableBuffer.aligns = parseAligns(parseCells(raw));

                return [provisionalTableRow(raw)];
            }
            if (TABLE_ROW_RE.test(raw)) {
                tableBuffer.rawLines.push(raw);
                tableBuffer.rows.push(parseCells(raw));

                return [provisionalTableRow(raw)];
            }
            // Table just ended. Finalize it, then process the current line
            // through the normal pipeline.
            const tableOut = finalizeTable(tableBuffer);
            tableBuffer = null;

            return [...tableOut, ...consumeLine(raw)];
        }
        // Inside an open code fence?
        if (codeBlock) {
            const fenceCloseRe = new RegExp(`^\\s*${codeBlock.fenceMarker}\\s*$`);
            if (fenceCloseRe.test(raw)) {
                // Close the block: emit highlighted code lines + the closing fence.
                const out = renderCodeFenceClose(codeBlock);
                out.push({ plain: raw, styled: gray(raw) });
                codeBlock = null;

                return out;
            }
            codeBlock.rawLines.push(raw);

            // Provisional rendering: dim while a normal block streams,
            // tinted blue for a thinking block so the user sees it building
            // up in the right colour from the first chunk.
            if (isThinkingLang(codeBlock.lang)) {
                return [{
                    plain: raw,
                    styled: palette.thinkingBar('│ ') + bold(palette.thinkingFg(raw)),
                }];
            }

            return [{ plain: raw, styled: gray('│ ') + dim(raw) }];
        }
        // Code fence open?
        const open = /^(```|~~~)\s*([A-Za-z0-9_+.\-]*)\s*$/.exec(raw);
        if (open) {
            codeBlock = { lang: open[2] || null, rawLines: [], fenceMarker: open[1] };
            const labelTxt = open[2] ? ` ${open[2]} ` : '';

            return [{ plain: raw, styled: gray(`╭─${labelTxt}${'─'.repeat(Math.max(0, 30 - labelTxt.length))}`) }];
        }
        // Start of a table?
        if (TABLE_ROW_RE.test(raw) || TABLE_SEP_RE.test(raw)) {
            tableBuffer = { rawLines: [raw], rows: [parseCells(raw)], sepIndex: -1, aligns: [] };
            if (TABLE_SEP_RE.test(raw)) {
                tableBuffer.sepIndex = 0;
                tableBuffer.aligns = parseAligns(parseCells(raw));
            }

            return [provisionalTableRow(raw)];
        }

        // Role banners expand to multiple rows (top rule + label + bottom
        // rule) for visual prominence. Intercept here so processCompletedLine
        // can return all three RenderedLines in one go.
        if (/^#{2,3}\s+/.test(raw)) {
            const role = ROLE_HEADER_RE.exec(raw);
            if (role) return renderRoleBanner(role[1], !!role[2], (role[3] ?? '').trim());
        }

        return [renderProseLine(raw)];
    };

    const renderTail = (raw: string): RenderedLine => {
        if (codeBlock) {
            // Inside fence; show provisional dim.
            return { plain: raw, styled: raw ? gray('│ ') + dim(raw) : '' };
        }

        return renderProseLine(raw);
    };

    return {
        feed: (chunk: string): FeedResult => {
            const text = pending + chunk;
            const parts = text.split('\n');
            pending = parts.pop() ?? '';
            const completed: RenderedLine[] = [];
            for (const raw of parts) completed.push(...consumeLine(raw));

            return { completed, tail: renderTail(pending) };
        },
        flush: (): RenderedLine[] => {
            const out: RenderedLine[] = [];
            if (pending) {
                for (const r of consumeLine(pending)) out.push(r);
                pending = '';
            }
            // Close any open table at end-of-message.
            if (tableBuffer) {
                out.push(...finalizeTable(tableBuffer));
                tableBuffer = null;
            }

            return out;
        },
        reset: (): void => { pending = ''; codeBlock = null; tableBuffer = null; },
    };
}
