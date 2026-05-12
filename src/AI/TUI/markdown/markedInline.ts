/**
 * Inline markdown -> ANSI via `marked` + `marked-terminal`.
 *
 * Wrapping the library so the rest of the renderer doesn't have to know
 * about its quirks (FORCE_COLOR detection, options, etc.). We use the
 * inline-only entry point because the surrounding streamRenderer already
 * deals with block-level structure (headings, lists, blockquotes,
 * tables, fenced code) and we just need correct handling of the inline
 * grammar (bold, italic, inline-code, links, strike, etc.).
 */

import { marked } from 'marked';
// `marked-terminal` ships as default export under CJS interop.
import TerminalRendererImport from 'marked-terminal';

const TerminalRenderer = (
    TerminalRendererImport as unknown as { default?: unknown }
).default ?? (TerminalRendererImport as unknown);

const renderer = new (TerminalRenderer as new (opts?: unknown) => unknown)({
    reflowText: false,
    width: 100000,
    tab: 2,
    showSectionPrefix: false,
    unescape: true,
});

marked.setOptions({ renderer: renderer as never });

export function renderInlineMarkdown(text: string): string {
    if (!text) return '';
    try {
        return marked.parseInline(text, { async: false }) as string;
    } catch {
        return text;
    }
}
