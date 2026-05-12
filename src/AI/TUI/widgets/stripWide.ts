/**
 * Strip codepoints that confuse blessed's `fullUnicode: true` cell-grid
 * accounting and cause glyph duplication / "letters bleeding everywhere"
 * when the transcript scrolls.
 *
 * Background: blessed appends invisible `\x03` cell-width markers after
 * every double-width codepoint when `fullUnicode` is on. Those markers
 * desync from the visible cell grid on any scroll/redraw, so emojis and
 * CJK in the chat content (e.g. the `👤 USER` / `🤖 ASSISTANT` headers,
 * or any emoji the model produces) leave ghost residue in subsequent
 * frames. (See memory: blessed scrollable text panels duplicate glyphs
 * on scroll under fullUnicode.)
 *
 * `sanitizeForBlessed` from the dashboard utils is too aggressive — it
 * replaces every codepoint > 0x7E with `?`, which would destroy the
 * box-drawing borders / bullets / arrows the markdown renderer relies
 * on for tables, code fences, blockquotes and lists. This helper keeps
 * everything that is single-width and only drops the troublemakers.
 */

// The five role-banner emojis we deliberately want to keep visible:
//   👤 USER  🤖 ASSISTANT  🔍 INVESTIGATOR  🌐 INVESTIGATOR-WEB  ⚙ EXECUTOR
// They're emitted at known fixed positions (one per turn) so the
// blessed cell-grid miscount has limited blast radius. Carved out of
// STRIP_RE via a leading negative lookahead.
const BANNER_EMOJI_EXEMPT = '\\u{1F464}\\u{1F916}\\u{1F50D}\\u{1F310}\\u{2699}';

const STRIP_RE = new RegExp(
    [
        // Plane-1 / supplementary planes — covers nearly every emoji,
        // EXCEPT the banner emojis carved out above.
        `(?![${BANNER_EMOJI_EXEMPT}])[\\u{1F000}-\\u{1FFFF}]`,
        // Misc Symbols + Dingbats (✓ ✗ ⚠ ☀ ⭐ etc.) which render
        // double-width when paired with the emoji variation selector.
        // Same banner-emoji carve-out for ⚙.
        `(?![${BANNER_EMOJI_EXEMPT}])[\\u{2600}-\\u{27BF}]`,
        // Variation selectors, ZWJ, combining keycap.
        '[\\u{FE00}-\\u{FE0F}\\u{200D}\\u{20E3}]',
    ].join('|'),
    'gu',
);

const WIDE_RE = new RegExp(
    [
        // Hangul Jamo, CJK, Kana, Hangul Syllables, Halfwidth/Fullwidth forms.
        '[\\u{1100}-\\u{115F}]',
        '[\\u{2E80}-\\u{303E}\\u{3041}-\\u{33FF}\\u{3400}-\\u{4DBF}\\u{4E00}-\\u{9FFF}]',
        '[\\u{A000}-\\u{A4CF}\\u{A960}-\\u{A97F}\\u{AC00}-\\u{D7A3}]',
        '[\\u{F900}-\\u{FAFF}\\u{FE30}-\\u{FE4F}\\u{FF01}-\\u{FF60}\\u{FFE0}-\\u{FFE6}]',
    ].join('|'),
    'gu',
);

/**
 * Remove emoji / variation-selector / wide CJK codepoints. Box-drawing,
 * arrows, bullets, smart quotes etc. are PRESERVED so the markdown
 * renderer's table borders and list glyphs survive.
 *
 * Wide CJK is replaced with `?` (so the user can still see SOMETHING was
 * there); pure decoration like emojis is dropped silently.
 */
export function stripWideChars(s: string): string {
    if (!s) return s;

    return s.replace(STRIP_RE, '').replace(WIDE_RE, '?');
}
