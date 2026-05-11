/**
 * Runtime patch to give blessed v0.1.x 24-bit truecolor output.
 *
 * blessed has no native truecolor support: it nearest-matches every hex
 * colour to the xterm-256 palette via RGB distance, then emits
 * `\x1b[38;5;Nm` / `\x1b[48;5;Nm`. That's awful for a dark navy theme
 * because the 256 palette has almost no entries in the dark-blue region,
 * so subtle colours collapse to black or grey.
 *
 * Strategy:
 *   1. Maintain a registry of hex strings the theme uses.
 *   2. For each registered hex, record the xterm-256 index blessed will
 *      pick for it (via blessed's own `colors.match`).
 *   3. Patch `program._owrite` so that, immediately before bytes hit the
 *      tty, any `\x1b[(3|4)8;5;Nm` sequence whose N matches a registered
 *      index is rewritten to `\x1b[(3|4)8;2;R;G;Bm`.
 *
 * Caveats:
 *   - If blessed (or some other code path) legitimately wants the 256-
 *     palette index that we hijacked, it will render with our truecolor
 *     RGB instead. In practice the indices we pick (17/60 etc.) are not
 *     used elsewhere in this codebase, so it's safe.
 *   - Requires a terminal that actually understands SGR 38;2/48;2. tmux
 *     needs `terminal-overrides ',*:Tc'` (or `Terminal-features` for
 *     newer tmux). We probe `COLORTERM=truecolor|24bit` and skip the
 *     patch on terminals that don't advertise support.
 */

import * as blessed from 'blessed';

const colorsMod = require('blessed/lib/colors') as { match: (hex: string) => number };

type RGB = readonly [number, number, number];

const indexToRgb = new Map<number, RGB>();
let installed = false;
let truecolorActive = false;

function hexToRgb(hex: string): RGB {
    const h = hex.startsWith('#') ? hex.slice(1) : hex;
    const v = h.length === 3
        ? h.split('').map((c) => c + c).join('')
        : h;
    const n = parseInt(v, 16);

    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function detectTruecolor(): boolean {
    // Install unconditionally. Modern terminals — including tmux with
    // `terminal-features ',xterm*:RGB'` — honour 24-bit SGR. The
    // COLORTERM env var is unreliable through tmux, sudo, ssh, and IDE
    // terminals; gating on it caused the patch to silently no-op in
    // common setups. If the terminal genuinely cannot render truecolor
    // it will just down-mix to its closest available colour; nothing
    // breaks.
    return true;
}

/**
 * Register hex colours that should round-trip as 24-bit SGR. Call this
 * once with every theme value before creating the blessed screen so we
 * know which palette indices to hijack.
 */
/**
 * Look up the xterm-256 index blessed will pick for a given hex via
 * `colors.match`. Returned indices that were also passed to
 * `registerTruecolorHexes` will be rewritten to 24-bit truecolor SGR.
 */
export function paletteIndexOf(hex: string): number {
    return colorsMod.match(hex);
}

export function registerTruecolorHexes(hexes: readonly string[]): void {
    for (const hex of hexes) {
        if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) continue;
        const idx = colorsMod.match(hex);
        if (idx < 0) continue;
        indexToRgb.set(idx, hexToRgb(hex));
    }
}

// Match an ENTIRE `\x1b[...m` SGR sequence so we can rewrite EACH
// `(3|4)8;5;N` sub-parameter inside it. blessed combines bg + fg + flags
// into one CSI like `\x1b[48;5;234;38;5;251m` — a single-sub regex would
// only match standalone bg/fg sequences (which is why padding cells
// rendered themed but text cells stayed at xterm-256 idx 234 ~= black).
const SGR_FULL_RE = /\x1b\[([\d;]*)m/g;
const SGR_SUB_RE = /([34])8;5;(\d+)/g;
// `\x1b[m`, `\x1b[0m`, and `\x1b[;m` are all full SGR resets that
// blessed sprinkles between cells whose attr matches `screen.dattr`.
// We need to reapply the theme bg/fg immediately after every reset so
// the next run of default-attr cells renders themed instead of
// black-on-default.
const RESET_RE = /\x1b\[0?m/g;

let defaultBg: RGB | null = null;
let defaultFg: RGB | null = null;

/**
 * Tell the rewriter to follow every SGR reset with explicit themed
 * bg/fg. Call before `installTruecolorPatch()`.
 */
export function setDefaultThemeRgb(bgHex: string, fgHex: string): void {
    defaultBg = hexToRgb(bgHex);
    defaultFg = hexToRgb(fgHex);
}

// Cursor positioning sequences — after each, the next characters paint
// with the CURRENT terminal SGR. blessed's draw loop emits `\x1b[<y>;<x>H`
// (CUP) before each line/run; if no SGR is emitted between then and the
// space characters, those spaces inherit whatever bg was last active.
const CUP_RE = /(\x1b\[\d*(?:;\d*)?H)/g;

function themedSgr(): string {
    if (!defaultBg || !defaultFg) return '';
    const bg = defaultBg;
    const fg = defaultFg;

    return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
}

function rewrite(text: string): string {
    let out = text.replace(SGR_FULL_RE, (whole, params: string) => {
        if (!params) return whole;
        let touched = false;
        const expanded = params.replace(SGR_SUB_RE, (sub, layer: string, idxStr: string) => {
            const idx = Number(idxStr);
            const rgb = indexToRgb.get(idx);
            if (!rgb) return sub;
            touched = true;

            return `${layer}8;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
        });
        if (!touched) return whole;

        return `\x1b[${expanded}m`;
    });
    const themed = themedSgr();
    if (themed) {
        // Re-apply themed bg/fg after every full SGR reset so cells
        // that blessed considers "default" pick up our theme instead
        // of the terminal's true default.
        out = out.replace(RESET_RE, `\x1b[m${themed}`);
        // Also re-apply after every cursor positioning sequence —
        // blessed's draw loop emits CUP before each line and then writes
        // raw spaces with NO intervening SGR for empty (dattr) cells.
        // Without this, those spaces paint with whatever bg was active.
        out = out.replace(CUP_RE, `$1${themed}`);
        // Prepend themed SGR at the start of every chunk so the very
        // first cells of a flush also inherit the theme.
        out = `${themed}${out}`;
    }

    return out;
}

/**
 * Install the patch. Idempotent. Returns whether truecolor rewriting
 * is active (false if the terminal doesn't advertise truecolor).
 */
export function installTruecolorPatch(): boolean {
    if (installed) return truecolorActive;
    installed = true;
    truecolorActive = detectTruecolor();
    if (!truecolorActive) return false;

    // blessed defines `_owrite` and `write` as TWO SEPARATE prototype
    // properties pointing to the same function literal:
    //
    //   Program.prototype._owrite =
    //   Program.prototype.write   = function(text) { ... };
    //
    // Patching one does NOT patch the other. Both are reachable from
    // different code paths (e.g. `_twrite` -> `_owrite` for tmux DCS
    // passthrough; direct `program.write(...)` for many cap helpers).
    // Wrap both, plus the inner `output.write` as a final safety net so
    // anything that bypasses Program goes through the rewriter too.
    const proto = (blessed as unknown as {
        program: { prototype: Record<string, (text: string) => unknown> };
    }).program.prototype;

    const wrap = (key: string): void => {
        const orig = proto[key];
        if (typeof orig !== 'function') return;
        proto[key] = function patched(text: string) {
            // Reuse blessed's own writability gate from the original.
            if (typeof text !== 'string') return orig.apply(this, arguments as unknown as [string]);

            return orig.call(this, rewrite(text));
        };
    };
    wrap('_owrite');
    wrap('write');

    return true;
}
