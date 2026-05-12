/**
 * Centralised colour palette for the Agent / AIChat blessed TUI.
 *
 * Keep this file tiny — anything more elaborate is overkill. The intent
 * is just to give us one obvious place to nudge the overall look.
 *
 * Backgrounds use hex so blessed renders them on real (truecolor / 256-
 * colour) terminals. Foregrounds prefer named colours where the
 * dim/bright distinction matters, falling back to hex for the new
 * subtler accents.
 */

/**
 * IMPORTANT: blessed v0.1.x does NOT support 24-bit truecolor — it maps
 * hex strings to the nearest xterm-256 palette entry via RGB distance.
 * That means very dark hex values like `#0d1b2a` collapse to black/grey
 * because the 256-palette has no dark-navy entries. To actually get a
 * navy panel on screen we must pick hex values that match real palette
 * cells (xterm indices 17, 18, 60, …).
 *
 * The values below correspond exactly to:
 *   #00005f → index 17 (deep navy)
 *   #5f5f87 → index 60 (muted blue-grey, used for raised strips)
 */

/*
 * Tokyo Night Storm-inspired palette. The colour relationships here
 * (background sequence, foreground contrast, semantic accents) are
 * proven to be easy on the eyes for long terminal sessions — it's the
 * basis of the most popular dark vim/tmux themes for a reason.
 *
 *   BG_PRIMARY  — main panel/background (deepest)
 *   BG_PANEL    — raised inline strips (status bar, modal headers, hints)
 *   BORDER_DIM  — calm borders that recede into the bg
 *   FG_BODY     — default body text (soft lavender, low chroma)
 *   FG_MUTED    — hints / gutter / inactive text
 *
 * Accents are reserved for *meaning*, not decoration: blue=info,
 * cyan=highlight, yellow=warn-soft, green=ok, red=err, magenta=special,
 * orange=user/attention. All are pulled directly from Tokyo Night so
 * they share the same colour temperature and chroma envelope, which is
 * what makes the theme feel cohesive instead of clown-vomit.
 */

/** Dark navy used for prompt + transcript + modal backgrounds. */
export const BG_PRIMARY = '#1a1b26';

/** Slightly lighter navy used for inline blocks (status bar, modal
 *  inner panels) so they read as "raised" against BG_PRIMARY. */
export const BG_PANEL = '#24283b';

/** Semantic accent colours — Tokyo Night palette. */
export const ACCENT_BLUE = '#7aa2f7';
export const ACCENT_CYAN = '#7dcfff';
export const ACCENT_YELLOW = '#e0af68';
export const ACCENT_GREEN = '#9ece6a';
export const ACCENT_RED = '#f7768e';
export const ACCENT_MAGENTA = '#bb9af7';
export const ACCENT_ORANGE = '#ff9e64';

/** Border colour used for non-emphasised modals. */
export const BORDER_DIM = '#414868';
/** Border colour used for emphasised modals (approval, errors). */
export const BORDER_ACCENT = ACCENT_BLUE;

/**
 * Default foreground for body text.
 *
 * #a9b1d6 (Tokyo Night fg-dark) instead of the brighter #c0caf5 so
 * extended reads of chat output don't strain the eye — the high-chroma
 * #c0caf5 looks crisp on a real GUI editor but reads as harsh / "rough
 * around the edges" in a terminal where the text rendering doesn't
 * antialias the same way.
 */
export const FG_BODY = '#a9b1d6';
/** Muted foreground for hints / status / gutter. */
export const FG_MUTED = '#565f89';

/**
 * Every hex defined above. Passed to `installTruecolorPatch` at
 * startup so blessed's 256-palette → 24-bit SGR rewrite covers them.
 * Keep in sync when adding new exports.
 */
export const THEME_HEXES: readonly string[] = [
    BG_PRIMARY,
    BG_PANEL,
    ACCENT_BLUE,
    ACCENT_CYAN,
    ACCENT_YELLOW,
    ACCENT_MAGENTA,
    ACCENT_GREEN,
    ACCENT_RED,
    ACCENT_ORANGE,
    BORDER_DIM,
    FG_BODY,
    FG_MUTED,
    '#2e3450',
];
