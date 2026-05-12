/**
 * ANSI-aware visual line wrapper.
 *
 * Splits a string with embedded SGR escapes into visual segments of
 * `width` columns, preserving the active SGR state across boundaries
 * so the second segment starts already in the correct color/attribute
 * (otherwise the colour set on the previous row would either bleed off
 * the right edge or be lost on the wrapped row).
 *
 * Used by promptPane + transcriptPane to soft-wrap long lines downward
 * instead of truncating off the right edge.
 */

const CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/y;
const RESET = '\x1b[0m';

// True for emoji / Misc-Symbols (incl. ⚙) / CJK / fullwidth code points
// that render in two terminal cells. Mirrors ansiWidth.ts — keep in sync.
function isWideCodePoint(cp: number): boolean {
    return (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2600 && cp <= 0x27bf) ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xa960 && cp <= 0xa97f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff01 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f000 && cp <= 0x1ffff)
    );
}

/**
 * Visual segment: `text` is the raw payload (already ANSI-balanced
 * with a trailing RESET if any escapes were present). `cols` is the
 * visible width of the segment (≤ `width`). `srcStart` / `srcEnd`
 * are byte indices into the original string for cursor mapping.
 */
export interface WrapSegment {
    text: string;
    cols: number;
    srcStart: number;
    srcEnd: number;
}

/**
 * Wrap a single logical line to `width` visible columns. Returns
 * AT LEAST one segment (an empty string returns one empty segment).
 *
 * SGR sequences are tracked across segment boundaries: every segment
 * after the first is prefixed with the active SGR stack so the colour
 * persists, and every segment that opened any SGR ends with a RESET.
 */
export function wrapAnsiLine(s: string, width: number): WrapSegment[] {
    if (width <= 0) return [{ text: '', cols: 0, srcStart: 0, srcEnd: 0 }];

    const segs: WrapSegment[] = [];
    let active: string[] = [];   // accumulated SGR escapes still in effect
    let buf = '';
    let cols = 0;
    let segStartActive: string[] = [];
    let srcStart = 0;
    // Word-wrap break candidate: snapshotted just after every whitespace
    // character. If the segment overflows we rewind here so words stay
    // intact instead of being chopped ("sme\nll" → "smell" on next row).
    let breakBufLen = -1;
    let breakCols = -1;
    let breakSrcIdx = -1;
    let breakActive: string[] = [];
    const len = s.length;
    let i = 0;

    const pushSegment = (srcEnd: number): void => {
        const prefix = segStartActive.length > 0 ? segStartActive.join('') : '';
        const suffix = active.length > 0 || segStartActive.length > 0 ? RESET : '';
        segs.push({
            text: prefix + buf + suffix,
            cols,
            srcStart,
            srcEnd,
        });
        buf = '';
        cols = 0;
        srcStart = srcEnd;
        segStartActive = active.slice();
        breakBufLen = -1;
        breakCols = -1;
        breakSrcIdx = -1;
    };

    while (i < len) {
        if (s.charCodeAt(i) === 0x1b && s.charCodeAt(i + 1) === 0x5b) {
            CSI_RE.lastIndex = i;
            const m = CSI_RE.exec(s);
            if (m) {
                buf += m[0];
                if (m[0] === RESET || /\x1b\[0?m/.test(m[0])) {
                    active = [];
                } else if (/m$/.test(m[0])) {
                    active.push(m[0]);
                }
                i += m[0].length;
                continue;
            }
        }
        if (cols >= width) {
            // Word-aware break: if we passed any whitespace within this
            // segment, rewind to it and start the next segment at the
            // following non-whitespace character. The original mid-word
            // hard-cut ("sme\nll") survives only as a fallback for tokens
            // longer than `width`.
            //
            // Probe trim BEFORE rewinding: if the prospective segment is
            // entirely whitespace (e.g. leading-space lines), rewinding
            // would jump `i` back to a position that overflows again at
            // the same break candidate — infinite loop. In that case
            // fall through to a plain hard-cut at the current `i` so we
            // make forward progress.
            //
            // Also skip the rewind when the overflowing character is
            // itself whitespace: rewinding would discard a long trailing
            // whitespace run (e.g. the bg-coloured pad on role banners),
            // shrinking the segment far below `width` and leaving the
            // remainder of the row uncoloured.
            const overflowCh = s[i];
            const overflowIsWs = overflowCh === ' ' || overflowCh === '\t';
            if (breakBufLen >= 0 && !overflowIsWs) {
                let trimLen = breakBufLen;
                let trimCols = breakCols;
                while (
                    trimLen > 0
                    && (buf.charCodeAt(trimLen - 1) === 0x20
                        || buf.charCodeAt(trimLen - 1) === 0x09)
                ) {
                    trimLen--;
                    trimCols--;
                }
                if (trimCols > 0) {
                    const rewindTo = breakSrcIdx;
                    active = breakActive;
                    buf = buf.slice(0, trimLen);
                    cols = trimCols;
                    pushSegment(rewindTo);
                    i = rewindTo;
                    continue;
                }
            }
            pushSegment(i);
        }
        const ch = s[i];
        if (ch === ' ' || ch === '\t') {
            buf += ch;
            cols++;
            i++;
            // Snapshot AFTER consuming the whitespace so the space stays
            // on the previous segment and the wrapped continuation starts
            // cleanly at the next word.
            breakBufLen = buf.length;
            breakCols = cols;
            breakSrcIdx = i;
            breakActive = active.slice();
            continue;
        }
        const cp = s.codePointAt(i) ?? 0;
        const cw = isWideCodePoint(cp) ? 2 : 1;
        // A wide glyph that would overshoot must wrap before it's
        // emitted, otherwise the row renders 1 cell too wide and the
        // last glyph bleeds onto the next visual line.
        if (cw === 2 && cols + cw > width && cols > 0) {
            pushSegment(i);
            continue;
        }
        const charLen = cp > 0xffff ? 2 : 1;
        buf += charLen === 2 ? s[i] + s[i + 1] : s[i];
        cols += cw;
        i += charLen;
    }
    pushSegment(len);

    return segs;
}

/**
 * Plain (no-ANSI) variant: splits a string into chunks of `width`
 * graphemes (here we treat one JS code unit = 1 cell, matching the
 * existing pane assumptions — wide-char support would require a
 * separate pass).
 */
export function wrapPlainLine(s: string, width: number): string[] {
    if (width <= 0) return [''];
    if (s.length <= width) return [s];
    const out: string[] = [];
    let i = 0;
    const len = s.length;
    while (i < len) {
        const remaining = len - i;
        if (remaining <= width) {
            out.push(s.slice(i));
            break;
        }
        // Try to break on whitespace within [i, i+width].
        let cut = -1;
        for (let j = i + width; j > i; j--) {
            const c = s[j];
            if (c === ' ' || c === '\t') { cut = j; break; }
        }
        if (cut < 0) {
            // No whitespace in window — hard-cut.
            out.push(s.slice(i, i + width));
            i += width;
            continue;
        }
        out.push(s.slice(i, cut));
        // Skip the run of whitespace at the break.
        i = cut;
        while (i < len && (s[i] === ' ' || s[i] === '\t')) i++;
    }

    return out;
}
