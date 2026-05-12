/**
 * Fancy welcome banner shown at the very top of an empty chat / agent
 * transcript. Pure ANSI — no blessed dependency — so the caller can
 * feed it through `appendTranscript` (raw) and have the truecolor patch
 * route the SGRs to whichever theme is in effect.
 *
 * The banner is intentionally lightweight: a one-line title with a
 * left-to-right gradient through the Tokyo Night accent family, framed
 * by faint slate rules, with a tiny subtitle showing provider · model.
 * Subtle, decorative, and invisible the moment the conversation
 * actually starts (it scrolls off naturally).
 */

const RESET = '\x1b[0m';

interface RGB { r: number; g: number; b: number; }

const hexToRgb = (hex: string): RGB => {
    const h = hex.startsWith('#') ? hex.slice(1) : hex;
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(v, 16);

    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

const TITLE_RGB = hexToRgb('#7aa2f7'); // Tokyo Night blue

const RULE_RGB = { r: 65, g: 72, b: 104 } as const; // Tokyo Night #414868
const SUBTITLE_RGB = { r: 86, g: 95, b: 137 } as const; // Tokyo Night #565f89

export interface WelcomeBannerLine {
    plain: string;
    styled: string;
}

/**
 * Build a multi-line banner as `{plain, styled}` pairs. The transcript
 * pane sanitises raw ANSI, but renders the `styled` slot verbatim, so
 * we pre-split into lines and let the caller feed them through the
 * styled-line API.
 *
 * The whole frame is centred horizontally inside `viewportWidth`. Title
 * uses a single Tokyo Night accent (no gradient) for a calmer look.
 */
export function buildWelcomeBanner(opts: {
    title: string;
    subtitle?: string;
    /** Inner box width (between the corners). Default 56. */
    width?: number;
    /** Outer viewport width to centre within. Default = box width. */
    viewportWidth?: number;
}): WelcomeBannerLine[] {
    const boxWidth = Math.max(20, Math.min(opts.width ?? 56, 80));
    const vw = Math.max(boxWidth, opts.viewportWidth ?? boxWidth);
    const outerPad = Math.max(0, Math.floor((vw - boxWidth) / 2));
    const outer = ' '.repeat(outerPad);

    const titleColor = `\x1b[38;2;${TITLE_RGB.r};${TITLE_RGB.g};${TITLE_RGB.b}m`;
    const ruleColor = `\x1b[38;2;${RULE_RGB.r};${RULE_RGB.g};${RULE_RGB.b}m`;
    const subColor = `\x1b[38;2;${SUBTITLE_RGB.r};${SUBTITLE_RGB.g};${SUBTITLE_RGB.b}m`;

    const innerCount = Math.max(0, boxWidth - 2);
    const ruleInner = '\u2500'.repeat(innerCount);
    const topRulePlain = outer + '\u256d' + ruleInner + '\u256e';
    const botRulePlain = outer + '\u2570' + ruleInner + '\u256f';

    const titleVis = opts.title;
    const titleVisLen = [...titleVis].length;
    const titlePad = Math.max(0, Math.floor((boxWidth - titleVisLen) / 2));
    const titleLeft = outer + ' '.repeat(titlePad);

    const out: WelcomeBannerLine[] = [];
    const blank = (): void => { out.push({ plain: '', styled: '' }); };

    blank();
    out.push({ plain: topRulePlain, styled: `${ruleColor}${topRulePlain}${RESET}` });
    blank();
    out.push({
        plain: titleLeft + titleVis,
        styled: `${titleLeft}${titleColor}${titleVis}${RESET}`,
    });
    blank();
    if (opts.subtitle && opts.subtitle.length > 0) {
        const subVis = opts.subtitle;
        const subPad = Math.max(0, Math.floor((boxWidth - subVis.length) / 2));
        const subLeft = outer + ' '.repeat(subPad);
        out.push({
            plain: subLeft + subVis,
            styled: `${subLeft}${subColor}${subVis}${RESET}`,
        });
        blank();
    }
    out.push({ plain: botRulePlain, styled: `${ruleColor}${botRulePlain}${RESET}` });
    blank();

    return out;
}
