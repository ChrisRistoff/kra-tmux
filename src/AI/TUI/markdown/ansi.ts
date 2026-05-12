// Tiny ANSI helpers. Avoids chalk (which is ESM-only at v5 and the project
// is CommonJS). All strings end with a reset so styles never leak.

export const RESET = '\x1b[0m';

const wrap = (open: string, close: string) =>
    (s: string): string => `${open}${s}${close}`;

export const bold = wrap('\x1b[1m', '\x1b[22m');
export const dim = wrap('\x1b[2m', '\x1b[22m');
export const italic = wrap('\x1b[3m', '\x1b[23m');
export const underline = wrap('\x1b[4m', '\x1b[24m');
export const inverse = wrap('\x1b[7m', '\x1b[27m');
export const strike = wrap('\x1b[9m', '\x1b[29m');

export const black = wrap('\x1b[30m', '\x1b[39m');
export const red = wrap('\x1b[31m', '\x1b[39m');
export const green = wrap('\x1b[32m', '\x1b[39m');
export const yellow = wrap('\x1b[33m', '\x1b[39m');
export const blue = wrap('\x1b[34m', '\x1b[39m');
export const magenta = wrap('\x1b[35m', '\x1b[39m');
export const cyan = wrap('\x1b[36m', '\x1b[39m');
export const white = wrap('\x1b[37m', '\x1b[39m');
export const gray = wrap('\x1b[90m', '\x1b[39m');

export const bgBlack = wrap('\x1b[40m', '\x1b[49m');
export const bgRed = wrap('\x1b[41m', '\x1b[49m');
export const bgGreen = wrap('\x1b[42m', '\x1b[49m');
export const bgYellow = wrap('\x1b[43m', '\x1b[49m');
export const bgBlue = wrap('\x1b[44m', '\x1b[49m');
export const bgMagenta = wrap('\x1b[45m', '\x1b[49m');
export const bgCyan = wrap('\x1b[46m', '\x1b[49m');

// 24-bit truecolor helpers — used for the muted markdown palette.
export const rgb = (r: number, g: number, b: number) =>
    wrap(`\x1b[38;2;${r};${g};${b}m`, '\x1b[39m');
export const bgRgb = (r: number, g: number, b: number) =>
    wrap(`\x1b[48;2;${r};${g};${b}m`, '\x1b[49m');

// Brighter, higher-contrast palette tuned for true-black backgrounds.
// Each accent gets a distinctive hue so the eye can scan structure quickly
// (headings, lists, blockquotes, tables, thinking blocks).
export const palette = {
    // Headings: cycle through warm-to-cool accents so nested structure is
    // visually distinct at a glance.
    h1: rgb(255, 184,  84),   // bright amber
    h2: rgb(122, 220, 255),   // bright cyan
    h3: rgb(187, 154, 247),   // violet
    h4: rgb(158, 230, 130),   // mint
    h5: rgb(247, 174, 198),   // rose
    h6: rgb(180, 190, 220),   // soft slate
    bullet:    rgb(255, 200,  80),  // warm yellow bullet glyph
    bar:       rgb(122, 220, 255),  // blockquote bar (matches h2)
    rule:      rgb(110, 122, 168),
    link:      rgb(122, 200, 255),
    codeBg:    bgRgb(24, 28, 42),
    codeFg:    rgb(232, 232, 248),
    fenceBar:  rgb(110, 122, 168),
    fenceFg:   rgb(220, 224, 240),
    // Thinking blocks (model chain-of-thought): bright blue, bold.
    // Use 256-color escape (\x1b[38;5;Nm) instead of 24-bit so it works
    // in tmux even without `terminal-overrides` set for truecolor, and
    // skip italic — many terminals/fonts render italic as inverted
    // colour or fall back to default fg, which is exactly the "thinking
    // text is white" complaint.
    thinkingBar: wrap('\x1b[38;5;75m', '\x1b[39m'),
    thinkingFg:  wrap('\x1b[38;5;111m', '\x1b[39m'),
    // Tables.
    tableBorder: rgb(110, 122, 168),
    tableHeader: rgb(255, 200,  80),
    tableCell:   rgb(220, 224, 240),
    // Status / inline accents.
    boldFg:      rgb(255, 235, 180),
    italicFg:    rgb(200, 215, 255),
    strikeFg:    rgb(140, 150, 175),
};
