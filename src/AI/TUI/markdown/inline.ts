import { bold, italic, dim, underline, gray, strike, palette } from './ansi';

// Inline markdown -> ANSI.
//
// Handled (in this order, non-overlapping by greedy left-to-right scan):
//   `code`              inline code (highest priority — content not re-styled)
//   **bold** / __bold__
//   *italic* / _italic_
//   ~~strike~~
//   [text](url)         link (text underlined cyan; url dimmed in parens)
//
// Everything else passes through verbatim. We deliberately avoid touching
// HTML/escapes — terminal users don't expect <em> markup.

const PATTERNS: Array<{
    re: RegExp;
    style: (m: RegExpExecArray) => string;
}> = [
    {
        // `code`
        re: /`([^`\n]+)`/g,
        style: (m) => palette.codeBg(palette.codeFg(` ${m[1]} `)),
    },
    {
        // **bold**
        re: /\*\*([^*\n]+)\*\*/g,
        style: (m) => bold(palette.boldFg(m[1])),
    },
    {
        // __bold__
        re: /__([^_\n]+)__/g,
        style: (m) => bold(palette.boldFg(m[1])),
    },
    {
        // *italic*  (no spaces inside, no leading * to avoid lists)
        re: /(?<![*])\*([^*\s][^*\n]*?)\*(?![*])/g,
        style: (m) => italic(palette.italicFg(m[1])),
    },
    {
        // _italic_
        re: /(?<![_\w])_([^_\s][^_\n]*?)_(?![_\w])/g,
        style: (m) => italic(palette.italicFg(m[1])),
    },
    {
        // ~~strike~~
        re: /~~([^~\n]+)~~/g,
        style: (m) => strike(palette.strikeFg(m[1])),
    },
    {
        // [text](url)
        re: /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
        style: (m) => `${underline(palette.link(m[1]))} ${dim(gray(`(${m[2]})`))}`,
    },
];

interface Span {
    start: number;
    end: number;
    rendered: string;
}

export function renderInline(text: string): string {
    if (!text) return '';

    const spans: Span[] = [];

    // Pass 1: inline code spans take priority. Mark them.
    const codeRe = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    const codeRanges: Array<[number, number]> = [];
    while ((m = codeRe.exec(text)) !== null) {
        spans.push({
            start: m.index,
            end: m.index + m[0].length,
            rendered: palette.codeBg(palette.codeFg(` ${m[1]} `)),
        });
        codeRanges.push([m.index, m.index + m[0].length]);
    }

    const inCode = (i: number): boolean =>
        codeRanges.some(([s, e]) => i >= s && i < e);

    // Pass 2: other patterns (skip code-protected ranges).
    for (let p = 1; p < PATTERNS.length; p++) {
        const { re, style } = PATTERNS[p];
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            const match = m;
            if (inCode(match.index)) continue;
            const matchEnd = match.index + match[0].length;
            const overlaps = spans.some(
                (s) => !(matchEnd <= s.start || match.index >= s.end),
            );
            if (overlaps) continue;
            spans.push({
                start: match.index,
                end: matchEnd,
                rendered: style(match),
            });
        }
    }

    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = 0;
    for (const s of spans) {
        if (s.start < cursor) continue;
        out += text.slice(cursor, s.start);
        out += s.rendered;
        cursor = s.end;
    }
    out += text.slice(cursor);

    return out;
}
