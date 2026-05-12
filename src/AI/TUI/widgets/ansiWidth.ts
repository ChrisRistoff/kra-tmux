/**
 * ANSI-aware width helpers for the transcript renderer.
 *
 * The markdown renderer emits raw `\x1b[...m` SGR sequences, which have
 * zero visible width. blessed itself does not strip them when computing
 * line widths, so a styled line that overshoots the box width is silently
 * truncated mid-escape, leaving the terminal in a coloured state for the
 * rest of the row (and visually "ghosting" residue from the previous frame
 * after a scroll). These helpers truncate at the *visible* column count,
 * always close any open SGR state with `\x1b[0m`, and pad with plain
 * spaces so blessed clears the trailing cells deterministically.
 *
 * The set of ANSI sequences we care about is narrow (CSI + a final byte).
 * We accept anything `\x1b[` ... letter so it's robust against truecolor
 * (`38;2;r;g;b`) and combined attribute sequences alike.
 */

const CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/y;
const RESET = '\x1b[0m';

/**
 * True if `cp` (a Unicode code point, NOT a UTF-16 char code) renders as a
 * double-width cell in modern terminals. We only need the ranges that can
 * actually appear in our styled output: emoji (Plane 1 supplementary), the
 * Misc-Symbols/Dingbats range (covers ⚙ and similar variation-selected
 * glyphs), and CJK / fullwidth blocks (preserved by stripWideChars when
 * sanitisation is bypassed). Keep this in sync with stripWide.ts.
 */
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

/** Returns the visible (rendered) width of a string with ANSI escapes. */
export function visibleWidth(s: string): number {
    let w = 0;
    for (let i = 0; i < s.length;) {
        if (s.charCodeAt(i) === 0x1b && s.charCodeAt(i + 1) === 0x5b) {
            CSI_RE.lastIndex = i;
            const m = CSI_RE.exec(s);
            if (m) { i += m[0].length; continue; }
        }
        const cp = s.codePointAt(i) ?? 0;
        w += isWideCodePoint(cp) ? 2 : 1;
        i += cp > 0xffff ? 2 : 1;
    }

    return w;
}

/**
 * Truncate `s` at `width` visible columns and pad with spaces to fill `width`.
 * ANSI escapes pass through but never count toward the column total, and a
 * `RESET` is always appended before the padding so trailing cells are not
 * coloured.
 */
export function truncateAndPad(s: string, width: number): string {
    if (width <= 0) return '';
    let out = '';
    let cols = 0;
    for (let i = 0; i < s.length;) {
        if (s.charCodeAt(i) === 0x1b && s.charCodeAt(i + 1) === 0x5b) {
            CSI_RE.lastIndex = i;
            const m = CSI_RE.exec(s);
            if (m) {
                out += m[0];
                i += m[0].length;
                continue;
            }
        }
        if (cols >= width) break;
        const cp = s.codePointAt(i) ?? 0;
        const cw = isWideCodePoint(cp) ? 2 : 1;
        // If a wide glyph would overflow by 1 cell, emit a space instead
        // and stop — never split a 2-cell glyph across the boundary.
        if (cols + cw > width) {
            out += ' ';
            cols++;
            break;
        }
        out += cp > 0xffff ? s[i] + s[i + 1] : s[i];
        cols += cw;
        i += cp > 0xffff ? 2 : 1;
    }
    // Always emit RESET, not just when this row carried SGR. Blessed
    // concatenates rows without inserting its own resets, so a row
    // that inherited an unclosed colour from the previous one (e.g.
    // when fullUnicode’s cell-grid drifts after a wide glyph and one
    // of our RESETs lands a cell off) would otherwise bleed colour
    // into the next visual row on scroll.
    out += RESET;
    if (cols < width) out += ' '.repeat(width - cols);

    return out;
}
