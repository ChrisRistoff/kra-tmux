/**
 * Blessed overlay file/folder picker. Replaces the `fzf` subprocess
 * picker so the TUI never has to surrender the screen — same UX as the
 * other modals (which-key, contexts popup, …).
 *
 * Layout (70% × 70%, centered):
 *   ┌─ pick files/folders (n selected) ───────────────────────────────┐
 *   │ filter > _                                                       │
 *   ├──────────────── 40% ─────────────┬──────── 60% preview ─────────┤
 *   │ + src/foo/bar.ts                 │ syntax-highlighted snippet…  │
 *   │   src/foo/baz.ts                 │                              │
 *   │   …                              │                              │
 *   └──────────────────────────────────┴──────────────────────────────┘
 *
 * Keys:
 *   type chars / backspace  → fuzzy/substring filter
 *   ↑/↓ · C-p/C-n · j/k     → move cursor
 *   Tab                     → toggle multi-select on current entry
 *   Enter                   → confirm (all selected, or current if none)
 *   Esc · C-c               → cancel (returns null)
 */

import * as blessed from 'blessed';
import * as fs from 'fs';
import * as path from 'path';
import { highlightCode } from '@/UI/dashboard/highlight';
import { pauseScreenKeys, sanitizeForBlessed } from '@/UI/dashboard';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM } from '../theme';

const PREVIEW_LINES = 400;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

export interface FilePickerOptions {
    title?: string | undefined;
    cwd: string;
    multi?: boolean | undefined;
}

function renderPreview(target: string): string {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(target);
    } catch (err) {
        return `${DIM}(cannot stat: ${(err as Error).message})${RESET}`;
    }
    if (stat.isDirectory()) {
        try {
            const rawEntries = fs.readdirSync(target, { withFileTypes: true });
            const entries = rawEntries
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;

                    return a.name.localeCompare(b.name);
                })
                .slice(0, PREVIEW_LINES);

            return sanitizeForBlessed(entries
                .map((e) => `${e.isDirectory() ? `\x00d\x00` : ' '} ${e.name}${e.isDirectory() ? '/' : ''}`)
                .join('\n'))
                .replace(/\x00d\x00/g, `${DIM}d${RESET}`);
        } catch (err) {
            return `${DIM}(cannot list: ${(err as Error).message})${RESET}`;
        }
    }
    let raw: string;
    try {
        raw = fs.readFileSync(target, 'utf8');
    } catch (err) {
        return `${DIM}(cannot read: ${(err as Error).message})${RESET}`;
    }
    if (raw.indexOf('\u0000') !== -1) return `${DIM}(binary file)${RESET}`;
    const all = raw.split('\n');
    const sliceLen = Math.min(all.length, PREVIEW_LINES);
    // Same fix as the grep dashboard preview: collapse anything >0x7E to '?'
    // BEFORE syntax-highlighting so blessed's fullUnicode cell-width markers
    // never desync on scroll. ANSI escapes are added AFTER sanitization so
    // they survive untouched. (stripWideChars is too lenient here — it
    // keeps smart quotes / en-dashes / bullets which are >0x7E and still
    // trigger the cell-grid bug on scroll/replace.)
    const sliced = sanitizeForBlessed(all.slice(0, sliceLen).join('\n'));
    const highlighted = highlightCode(sliced, target);
    const lines = highlighted.split('\n');
    const width = String(lines.length).length;
    const gutter = lines.map((ln, i) => {
        const num = String(i + 1).padStart(width, ' ');

        return `${DIM}${num} \u2502${RESET} ${ln}`;
    }).join('\n');
    if (all.length > sliceLen) {
        return `${gutter}\n${DIM}\u2026 (${all.length - sliceLen} more lines)${RESET}`;
    }

    return gutter;
}


/** Score a haystack/needle match. Higher = better; -1 = no match.
 *  Ranks basename matches above directory matches, exact > prefix >
 *  substring > subsequence, and penalises gap length so e.g. typing
 *  `testfile` puts `testfile.ts` ahead of `__tests__/foo.test.ts`. */
function fuzzyScore(haystack: string, needle: string): number {
    if (!needle) return 0;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    const slash = h.lastIndexOf('/');
    const base = slash >= 0 ? h.slice(slash + 1) : h;

    if (base === n) return 10000;
    if (base.startsWith(n)) return 5000 - base.length;
    const baseSubIdx = base.indexOf(n);
    if (baseSubIdx >= 0) return 3000 - baseSubIdx - base.length;
    const pathSubIdx = h.indexOf(n);
    if (pathSubIdx >= 0) return 1500 - pathSubIdx;

    // Subsequence in basename.
    let i = 0, gaps = 0, lastIdx = -1;
    let ok = true;
    for (const ch of n) {
        const idx = base.indexOf(ch, i);
        if (idx === -1) { ok = false; break; }
        if (lastIdx >= 0) gaps += idx - lastIdx - 1;
        lastIdx = idx;
        i = idx + 1;
    }
    if (ok) return 800 - gaps - base.length;

    // Subsequence in full path.
    i = 0; gaps = 0; lastIdx = -1;
    for (const ch of n) {
        const idx = h.indexOf(ch, i);
        if (idx === -1) return -1;
        if (lastIdx >= 0) gaps += idx - lastIdx - 1;
        lastIdx = idx;
        i = idx + 1;
    }

    return 200 - gaps;
}

export async function blessedFilePicker(
    screen: blessed.Widgets.Screen,
    entries: string[],
    opts: FilePickerOptions,
): Promise<string[] | null> {
    return new Promise((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape', 'enter', 'tab']);
        const savedFocus = screen.focused;

        const cwd = opts.cwd;
        const multi = opts.multi !== false;
        const selected = new Set<string>();

        const display = (abs: string): string => {
            let rel: string;
            if (abs === cwd) rel = './';
            else if (abs.startsWith(cwd + path.sep)) rel = abs.slice(cwd.length + 1);
            else rel = abs;

            return sanitizeForBlessed(rel);
        };

        const container = blessed.box({
            parent: screen,
            label: ` ${opts.title ?? 'pick files/folders'} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height: '70%',
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
        });

        const filter = blessed.textbox({
            parent: container,
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            inputOnFocus: false,
            keys: false,
            mouse: false,
            style: { fg: 'white', bg: BG_PANEL },
        });
        filter.setValue('filter > ');

        const list = blessed.list({
            parent: container,
            top: 1,
            left: 0,
            width: '40%',
            bottom: 1,
            border: { type: 'line' },
            style: {
                border: { fg: BORDER_DIM },
                selected: { bg: 'cyan', fg: 'black', bold: true },
                item: { fg: 'white' },
                bg: BG_PRIMARY,
            },
            keys: false,
            mouse: true,
            tags: false,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            items: [],
        });

        const preview = blessed.box({
            parent: container,
            top: 1,
            left: '40%',
            right: 0,
            bottom: 1,
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
            tags: false,
            mouse: false,
            scrollable: true,
            alwaysScroll: true,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
        });

        const status = blessed.box({
            parent: container,
            bottom: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: false,
            style: { fg: 'gray', bg: BG_PANEL },
        });


        let query = '';
        let filtered: string[] = entries.slice();

        const updateStatus = (): void => {
            const total = entries.length;
            const shown = filtered.length;
            const sel = selected.size;
        const tip = multi
                ? '<Tab> toggle  <CR> confirm  <Esc> cancel  <S-↑/↓> preview'
                : '<CR> confirm  <Esc> cancel  <S-↑/↓> preview';
            status.setContent(` ${shown}/${total} · ${sel} selected · ${tip}`);
        };

        const getSelected = (): number => (list as unknown as { selected: number }).selected;

        const refreshList = (): void => {
            const items = filtered.map((abs) => {
                const mark = selected.has(abs) ? '+ ' : '  ';

                return mark + display(abs);
            });
            list.setItems(items);
            if (getSelected() >= items.length) list.select(Math.max(0, items.length - 1));
            updatePreview();
            updateStatus();
            screen.render();
        };

        // Visible-width-aware right-pad: cli-highlight emits ANSI escape
        // sequences (\x1b[...m) that count as zero printed cells. Strip
        // them when measuring length so each line ends up filling the
        // preview's inner width — this overwrites leftover characters from
        // the previously-shown file when blessed renders the new content.
        // (Bug surfaces on plain-text files; highlighted output naturally
        // ends with `\x1b[0m` resets which masks the issue.)
        const ANSI_RE = /\x1b\[[0-9;]*m/g;
        const padToWidth = (content: string): string => {
            const innerWidth = Math.max(
                1,
                ((preview as unknown as { width: number }).width ?? 80) - 2,
            );

            return content.split('\n').map((ln) => {
                const visible = ln.replace(ANSI_RE, '').length;
                if (visible >= innerWidth) return ln;

                return ln + ' '.repeat(innerWidth - visible);
            }).join('\n');
        };

        const updatePreview = (): void => {
            const idx = getSelected();
            const abs = filtered[idx];
            const raw = abs ? renderPreview(abs) : `${DIM}(no entry)${RESET}`;
            preview.setContent(padToWidth(raw));
            preview.scrollTo(0);
        };

        const applyFilter = (): void => {
            if (query) {
                // Score every entry, drop misses, sort by descending score.
                // `display(e)` gives the relative path the user actually sees,
                // which is what should drive ranking.
                const scored = entries
                    .map((e) => ({ e, s: fuzzyScore(display(e), query) }))
                    .filter((x) => x.s >= 0);
                scored.sort((a, b) => b.s - a.s);
                filtered = scored.map((x) => x.e);
            } else {
                filtered = entries.slice();
            }
            list.select(0);
            filter.setValue(`filter > ${query}`);
            refreshList();
        };

        const cleanup = (result: string[] | null): void => {
            container.destroy();
            restoreKeys();
            if (savedFocus && typeof (savedFocus as { focus?: () => void }).focus === 'function') {
                try { (savedFocus as { focus: () => void }).focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(result);
        };

        list.on('select item', () => updatePreview());

        const cancel = (): void => cleanup(null);
        const confirm = (): void => {
            if (selected.size > 0) {
                cleanup(Array.from(selected));

                return;
            }
            const idx = getSelected();
            const abs = filtered[idx];
            cleanup(abs ? [abs] : null);
        };
        const toggle = (): void => {
            if (!multi) return;
            const idx = getSelected();
            const abs = filtered[idx];
            if (!abs) return;
            if (selected.has(abs)) selected.delete(abs);
            else selected.add(abs);
            // Move cursor down so the user can rapidly multi-select.
            if (idx < filtered.length - 1) list.select(idx + 1);
            refreshList();
        };

        list.key(['escape', 'C-c'], cancel);
        list.key(['enter'], confirm);
        list.key(['tab'], toggle);
        // Wrap-around: on first item, `k`/up jumps to last; on last,
        // `j`/down jumps to first. Mirrors Telescope/fzf behaviour.
        list.key(['up', 'k', 'C-p'], () => {
            const idx = getSelected();
            if (idx <= 0) list.select(Math.max(0, filtered.length - 1));
            else list.up(1);
            updatePreview();
            screen.render();
        });
        list.key(['down', 'j', 'C-n'], () => {
            const idx = getSelected();
            if (idx >= filtered.length - 1) list.select(0);
            else list.down(1);
            updatePreview();
            screen.render();
        });
        list.key(['pageup', 'C-u'], () => { list.up(10); updatePreview(); screen.render(); });
        list.key(['pagedown', 'C-d'], () => { list.down(10); updatePreview(); screen.render(); });
        list.key(['C-w'], () => { query = ''; applyFilter(); });
        list.key(['backspace'], () => { query = query.slice(0, -1); applyFilter(); });

        const scrollPreview = (delta: number): void => {
            (preview as unknown as { scroll: (n: number) => void }).scroll(delta);
            screen.render();
        };
        list.key(['S-down'], () => scrollPreview(1));
        list.key(['S-up'], () => scrollPreview(-1));
        list.key(['S-right'], () => scrollPreview(10));
        list.key(['S-left'], () => scrollPreview(-10));

        list.on('keypress', (ch, key) => {
            if (!ch) return;
            if (key && (key.ctrl || key.meta)) return;
            // Reserved keys handled above.
            const reserved = new Set([
                'escape', 'enter', 'tab', 'up', 'down', 'left', 'right',
                'pageup', 'pagedown', 'backspace', 'k', 'j',
            ]);
            if (key && reserved.has(key.name)) return;
            if (ch.length === 1 && ch >= ' ' && ch !== '\x7f') {
                query += ch;
                applyFilter();
            }
        });

        applyFilter();
        list.focus();
        screen.render();
    });
}
