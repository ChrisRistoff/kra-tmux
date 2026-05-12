export function escTag(s: string): string {
    return s.replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

// Strip characters that confuse blessed's cell-width tracking when the screen
// has fullUnicode: true. blessed appends \x03 markers after every double-width
// codepoint and on scroll those markers desync from the visible cell grid,
// duplicating glyphs at wrong positions. This sanitizer collapses anything
// outside printable ASCII to '?', expands tabs to 4 spaces, and drops CR /
// other control bytes. Use it on any content sourced from arbitrary files or
// shell output before injecting into a scrollable blessed panel.
export function sanitizeForBlessed(s: string): string {
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0x09) { out += '    '; continue; }
        if (cp === 0x0a) { out += '\n'; continue; }
        if (cp === 0x0d) continue;
        if (cp < 0x20) continue;
        if (cp === 0x7f) continue;
        if (cp > 0x7e) { out += '?'; continue; }
        out += ch;
    }

    return out;
}
