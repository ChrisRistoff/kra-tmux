/**
 * Session File History overlay (blessed). Mirrors the legacy nvim
 * `<leader>s` Telescope picker — every successful tool-driven write this
 * session is recorded as a `VersionEntry` on `state.history`, and this
 * modal lets the user step forward/back through them, preview each diff,
 * and revert any file to any past version.
 *
 * Layout
 *   ┌──────── Session File History (N files · M writes) ────────┐
 *   │ Files+Versions               │  Diff preview               │
 *   │  ▼ src/foo.ts (3)            │  --- v1 (writeFile)         │
 *   │     #2 12:31 +5 -2 edit      │  +++ v2 (edit)              │
 *   │     #1 12:30 +12 -0 writeFile│  @@ ...                     │
 *   │     ORIG  pre-session        │  - old line                 │
 *   │  ▼ src/bar.ts (1)            │  + new line                 │
 *   │     #1 12:32 +3 -0 writeFile │                             │
 *   │     ORIG  pre-session        │                             │
 *   │                              │                             │
 *   │ j/k  navigate · r revert · R revert-all · q close          │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Keys (focused on the list pane):
 *   j / k / arrows / pgup/pgdn  — navigate
 *   r                            — revert file to selected version (confirm)
 *   R                            — revert ALL files to pre-session original
 *   S-up/down/left/right         — scroll the diff preview
 *   q / esc                      — close
 */

import * as blessed from 'blessed';
import { promises as fs } from 'fs';
import * as path from 'path';
import { pauseScreenKeys, highlightCode } from '@/UI/dashboard';
import { truncateAndPad } from './ansiWidth';
import type { AgentHistory, VersionEntry } from '@/AI/AIAgent/shared/utils/agentHistory';
import { confirmModal } from './contextsModal';
import { showDiffReviewModal } from './diffReviewModal';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM } from '../theme';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

interface FileRow {
    kind: 'file';
    path: string;
    versionCount: number;
}

interface VersionRow {
    kind: 'version';
    path: string;
    version: VersionEntry;
    /** The version that immediately precedes this one in the list (older).
     *  Used to compute the diff (this.afterSha vs prev.afterSha). For ORIG
     *  this is null and we show the file's pre-session content. */
    prev: VersionEntry | null;
}

type Row = FileRow | VersionRow;

export interface SessionHistoryOptions {
    history: AgentHistory;
    notify?: (msg: string, lingerMs?: number) => void;
}

function fmtTimestamp(ts: number): string {
    if (ts === 0) return '          ';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');

    return `${hh}:${mm}:${ss}`;
}

function relPath(absPath: string): string {
    const cwd = process.cwd();
    if (absPath.startsWith(cwd + '/')) return absPath.slice(cwd.length + 1);

    return absPath;
}

function buildRows(history: AgentHistory): Row[] {
    const rows: Row[] = [];
    const paths = history.listChangedPaths().sort();
    for (const p of paths) {
        const versions = history.listVersions(p);
        if (versions.length === 0) continue;
        // Original is at index 0; mutations 1..N. Display newest first, then ORIG.
        const muts = versions.slice(1);
        rows.push({ kind: 'file', path: p, versionCount: muts.length });
        // newest first
        for (let i = muts.length - 1; i >= 0; i--) {
            rows.push({
                kind: 'version',
                path: p,
                version: muts[i],
                prev: i === 0 ? versions[0] : muts[i - 1],
            });
        }
        // ORIG row
        rows.push({
            kind: 'version',
            path: p,
            version: versions[0],
            prev: null,
        });
    }

    return rows;
}

function formatRow(row: Row): string {
    if (row.kind === 'file') {
        return `${BOLD}${CYAN}▼ ${relPath(row.path)}${RESET} ${DIM}(${row.versionCount} write${row.versionCount === 1 ? '' : 's'})${RESET}`;
    }
    const v = row.version;
    if (v.kind === 'original') {
        return `   ${DIM}ORIG  pre-session baseline${RESET}`;
    }
    const ts = fmtTimestamp(v.timestamp);
    const seq = `#${String(v.seq).padStart(2, ' ')}`;
    const delta = `${GREEN}+${v.addedLines}${RESET} ${RED}-${v.removedLines}${RESET}`;

    return `   ${YELLOW}${seq}${RESET}  ${ts}  ${delta}  ${DIM}${v.source}${RESET}`;
}

/** Render a Neovim-style side-by-side diff: two highlighted columns with
 *  red bg on the left for removed lines, green bg on the right for added
 *  lines, blank fillers where one side has no counterpart, and unchanged
 *  lines on both sides. Returns one string with both columns joined per row
 *  by a center separator, ready to drop into a single scrollable box. */
function renderSplitDiff(
    beforeText: string,
    afterText: string,
    filePath: string,
    totalWidth: number,
): { text: string; firstDiffLine: number } {
    const a = beforeText === '' ? [] : beforeText.split('\n');
    const b = afterText === '' ? [] : afterText.split('\n');
    if (a.length === 0 && b.length === 0) {
        return { text: `${DIM}(no content)${RESET}`, firstDiffLine: -1 };
    }
    const MAX = 5000;
    if (a.length > MAX || b.length > MAX) {
        return { text: `${DIM}(file too large for split diff: ${a.length} → ${b.length} lines)${RESET}`, firstDiffLine: -1 };
    }
    // LCS over raw lines so the diff is computed on actual content, not on
    // post-highlighting ANSI-colored strings.
    const n = a.length, m = b.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const idx = i * (m + 1) + j;
            if (a[i] === b[j]) dp[idx] = dp[idx + (m + 1) + 1] + 1;
            else dp[idx] = Math.max(dp[idx + (m + 1)], dp[idx + 1]);
        }
    }
    type Op = { op: ' ' | '-' | '+'; aIdx: number; bIdx: number };
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ op: ' ', aIdx: i, bIdx: j }); i++; j++; }
        else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
            ops.push({ op: '-', aIdx: i, bIdx: -1 }); i++;
        } else {
            ops.push({ op: '+', aIdx: -1, bIdx: j }); j++;
        }
    }
    while (i < n) ops.push({ op: '-', aIdx: i++, bIdx: -1 });
    while (j < m) ops.push({ op: '+', aIdx: -1, bIdx: j++ });

    // Pre-highlight both sides per-line so column ANSI background tags can
    // be wrapped around already-highlighted content.
    const aHl = a.length > 0 ? highlightCode(a.join('\n'), filePath).split('\n') : [];
    const bHl = b.length > 0 ? highlightCode(b.join('\n'), filePath).split('\n') : [];

    const SEP = `${DIM} │ ${RESET}`;
    // totalWidth is the inner width of the preview box (already minus borders).
    // Reserve 3 cols for the center separator, then split the rest in half.
    const inner = Math.max(20, totalWidth - 3);
    const colWidth = Math.floor(inner / 2);
    const aGutter = String(n).length;
    const bGutter = String(m).length;
    // Visible width budget for the actual code text per column = colWidth
    // minus gutter digits, marker char, and one space.
    const aCode = Math.max(4, colWidth - aGutter - 3);
    const bCode = Math.max(4, colWidth - bGutter - 3);

    // Dim 256-color backgrounds so the syntax-highlighted foreground stays
    // readable on top (the standard 41/42/100 codes wash everything out).
    const RED_BG = '\x1b[48;5;52m';   // dark red
    const GREEN_BG = '\x1b[48;5;22m'; // dark green
    const FILLER_BG = '\x1b[48;5;236m'; // very dark gray = visual filler

    const fmtSide = (
        gutterW: number,
        codeW: number,
        marker: string,
        bg: string,
        lineNo: number | null,
        body: string,
    ): string => {
        const num = lineNo === null ? ''.padStart(gutterW, ' ') : String(lineNo).padStart(gutterW, ' ');
        const left = `${DIM}${num}${RESET}${marker}`;
        const padded = truncateAndPad(body, codeW);

        return `${left}${bg}${padded}${RESET}`;
    };

    const out: string[] = [];
    let firstDiffLine = -1;
    for (const o of ops) {
        if (firstDiffLine === -1 && o.op !== ' ') firstDiffLine = out.length;
        if (o.op === ' ') {
            const left = fmtSide(aGutter, aCode, ' ', '', o.aIdx + 1, aHl[o.aIdx] ?? '');
            const right = fmtSide(bGutter, bCode, ' ', '', o.bIdx + 1, bHl[o.bIdx] ?? '');
            out.push(`${left}${SEP}${right}`);
        } else if (o.op === '-') {
            const left = fmtSide(aGutter, aCode, '-', RED_BG, o.aIdx + 1, aHl[o.aIdx] ?? '');
            const right = fmtSide(bGutter, bCode, ' ', FILLER_BG, null, '');
            out.push(`${left}${SEP}${right}`);
        } else {
            const left = fmtSide(aGutter, aCode, ' ', FILLER_BG, null, '');
            const right = fmtSide(bGutter, bCode, '+', GREEN_BG, o.bIdx + 1, bHl[o.bIdx] ?? '');
            out.push(`${left}${SEP}${right}`);
        }
    }

    return { text: out.join('\n'), firstDiffLine };
}




export async function showSessionHistoryModal(
    screen: blessed.Widgets.Screen,
    opts: SessionHistoryOptions,
): Promise<void> {
    const notify = opts.notify ?? ((): void => { /* noop */ });
    const history = opts.history;

    let rows = buildRows(history);
    if (rows.length === 0) {
        notify('no file changes recorded this session', 2500);

        return;
    }

    return new Promise<void>((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'Q', 'C-c', 'escape', 'enter', 'r', 'R']);
        const savedFocus = screen.focused;

        const container = blessed.box({
            parent: screen,
            label: ' Session File History ',
            top: 'center',
            left: 'center',
            width: '90%',
            height: '85%',
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
            tags: false,
        });

        const header = blessed.box({
            parent: container,
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: false,
            style: { fg: 'white', bg: BG_PANEL },
        });

        const list = blessed.list({
            parent: container,
            top: 1,
            left: 0,
            width: '45%',
            bottom: 1,
            border: { type: 'line' },
            keys: false,
            mouse: true,
            tags: false,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: {
                border: { fg: BORDER_DIM },
                selected: { bg: 'cyan', fg: 'black', bold: true },
                item: { fg: 'white' },
                bg: BG_PRIMARY,
            },
            items: [],
        });

        const preview = blessed.box({
            parent: container,
            top: 1,
            left: '45%',
            right: 0,
            bottom: 1,
            border: { type: 'line' },
            tags: false,
            mouse: false,
            scrollable: true,
            alwaysScroll: true,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
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

        const getSel = (): number => (list as unknown as { selected: number }).selected;

        const refreshHeader = (): void => {
            const fileCount = rows.filter((r) => r.kind === 'file').length;
            const writeCount = rows.filter((r) => r.kind === 'version' && r.version.kind === 'mutation').length;
            header.setContent(` ${BOLD}${fileCount}${RESET} file${fileCount === 1 ? '' : 's'} · ${BOLD}${writeCount}${RESET} write${writeCount === 1 ? '' : 's'} this session`);
        };

        const refreshStatus = (): void => {
            status.setContent(' j/k navigate · r revert to version · R revert all · S-↑/↓ scroll diff · q close');
        };

        const refreshList = (): void => {
            list.setItems(rows.map(formatRow));
            if (getSel() >= rows.length) list.select(Math.max(0, rows.length - 1));
        };

        const updatePreview = async (): Promise<void> => {
            const idx = getSel();
            const row = rows[idx];
            if (!row) {
                preview.setContent(`${DIM}(empty)${RESET}`);

                return;
            }
            if (row.kind === 'file') {
                const versions = history.listVersions(row.path);
                preview.setContent(
                    `${BOLD}${row.path}${RESET}\n\n${DIM}${versions.length - 1} write(s) recorded this session.\nSelect a version below to preview the diff.${RESET}`
                );
                (preview as unknown as { setScrollPerc: (n: number) => void }).setScrollPerc(0);
                screen.render();

                return;
            }
            // Version row → render the Neovim-style split diff: BEFORE on the
            // left (red bg for removed lines), AFTER on the right (green bg
            // for added lines), with syntax highlighting on both sides.
            try {
                const v = row.version;
                const prev = row.prev;
                const after = v.afterSha === null ? '' : await history.loadVersionContent(v.afterSha);
                const before = prev === null
                    ? '' // ORIG row — nothing came before
                    : (prev.afterSha === null ? '' : await history.loadVersionContent(prev.afterSha));
                const fromLabel = prev === null
                    ? '(none)'
                    : prev.kind === 'original' ? 'pre-session' : `#${prev.seq} ${prev.source}`;
                const toLabel = v.kind === 'original'
                    ? 'pre-session baseline'
                    : `#${v.seq} ${v.source}`;
                const w = (preview.width as number) - 2; // minus borders
                const split = renderSplitDiff(before, after, row.path, w);
                const banner = `${BOLD}${relPath(row.path)}${RESET}  ${DIM}${fromLabel}${RESET} → ${BOLD}${toLabel}${RESET}\n${DIM}───${RESET}`;
                const bannerLines = 2;
                // Pad every line to the box's inner width so blessed clears
                // the leftover characters from the previously-rendered version
                // (otherwise unchanged-row tails leak through on selection
                // change, since they have no ANSI bg color to repaint with).
                const ANSI_RE = /\x1b\[[0-9;]*m/g;
                const padded = (banner + '\n' + split.text).split('\n').map((ln) => {
                    const visible = ln.replace(ANSI_RE, '').length;
                    if (visible >= w) return ln;

                    return ln + ' '.repeat(w - visible);
                }).join('\n');
                preview.setContent(padded);
                // Auto-scroll to the first diff so users don't have to hunt
                // through long unchanged prefixes (e.g. 1-line change in a
                // 1000-line file). Leave a small context margin above.
                const previewH = (preview.height as number) - 2;
                if (split.firstDiffLine >= 0) {
                    // Place the first changed line exactly at the top of the
                    // visible area (no extra context). Users can scroll up
                    // with S-↑ / S-← to see the unchanged prefix.
                    const target = bannerLines + split.firstDiffLine;
                    const totalLines = padded.split('\n').length;
                    const maxTop = Math.max(0, totalLines - previewH);
                    (preview as unknown as { scrollTo: (n: number) => void }).scrollTo(Math.min(target, maxTop));
                } else {
                    (preview as unknown as { setScrollPerc: (n: number) => void }).setScrollPerc(0);
                }
                screen.render();
            } catch (err) {
                preview.setContent(`${RED}Failed to render diff: ${err instanceof Error ? err.message : String(err)}${RESET}`);
                screen.render();
            }
        };

        const cleanup = (): void => {
            try { restoreKeys(); } catch { /* noop */ }
            try { container.destroy(); } catch { /* noop */ }
            try { (savedFocus as { focus?: () => void } | null)?.focus?.(); } catch { /* noop */ }
            screen.render();
            resolve();
        };

        const reload = (): void => {
            const prevSel = getSel();
            rows = buildRows(history);
            if (rows.length === 0) {
                cleanup();

                return;
            }
            refreshHeader();
            refreshList();
            list.select(Math.min(prevSel, rows.length - 1));
            void updatePreview();
        };

        const doRevertOne = async (): Promise<void> => {
            const row = rows[getSel()];
            if (!row || row.kind !== 'version') return;
            const label = row.version.kind === 'original'
                ? 'pre-session baseline'
                : `#${row.version.seq} (${row.version.source})`;
            // Open the real `nvim -d` (vimdiff) with the current file vs. the
            // target-version content. <leader>a approves and writes the (possibly
            // user-edited) target back to the real file, <leader>d / q cancels.
            // Reverts deliberately do NOT record a new history entry — the
            // revert is a write-through.
            let currentContent = '';
            try { currentContent = await fs.readFile(row.path, 'utf8'); } catch { currentContent = ''; }
            const target = row.version.afterSha === null
                ? ''
                : await history.loadVersionContent(row.version.afterSha);
            const result = await showDiffReviewModal(screen, {
                displayPath: row.path,
                currentContent,
                proposedContent: target,
                proposedEndsWithNewline: target.endsWith('\n'),
                toolName: 'session-history-revert',
                note: `revert → ${label}`,
            });
            if (result.kind !== 'approve') {
                notify(`revert cancelled`, 1500);

                return;
            }
            try {
                await fs.mkdir(path.dirname(row.path), { recursive: true });
                if (result.editedContent === '' && row.version.afterSha === null) {
                    await fs.rm(row.path, { force: true });
                } else {
                    await fs.writeFile(row.path, result.editedContent, 'utf8');
                }
                notify(`reverted ${relPath(row.path)} → ${label}`, 2500);
                reload();
            } catch (err) {
                notify(`revert failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
            }
        };

        const doRevertAll = async (): Promise<void> => {
            const ok = await confirmModal(screen, 'Revert all', `Revert ALL ${history.listChangedPaths().length} changed file(s) to pre-session?`);
            if (!ok) return;
            const paths = history.listChangedPaths();
            let n = 0;
            for (const p of paths) {
                const versions = history.listVersions(p);
                const orig = versions[0];
                if (!orig) continue;
                if (await history.revertToVersion(p, orig)) n++;
            }
            notify(`reverted ${n}/${paths.length} file(s) to pre-session`, 3000);
            reload();
        };

        list.on('select item', () => { void updatePreview(); });

        list.key(['escape', 'q', 'C-c'], () => cleanup());
        list.key(['up', 'k', 'C-p'], () => { list.up(1); screen.render(); });
        list.key(['down', 'j', 'C-n'], () => { list.down(1); screen.render(); });
        list.key(['pageup', 'C-u'], () => { list.up(10); screen.render(); });
        list.key(['pagedown', 'C-d'], () => { list.down(10); screen.render(); });
        list.key(['S-down'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(1); screen.render(); });
        list.key(['S-up'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(-1); screen.render(); });
        list.key(['S-right'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(10); screen.render(); });
        list.key(['S-left'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(-10); screen.render(); });
        list.key(['r'], () => { void doRevertOne(); });
        list.key(['S-r'], () => { void doRevertAll(); });

        refreshHeader();
        refreshList();
        refreshStatus();
        // Default-select the first version row (skip the file header) so the
        // preview pane shows a real diff right away.
        const firstVer = rows.findIndex((r) => r.kind === 'version');
        if (firstVer >= 0) list.select(firstVer);
        void updatePreview();
        list.focus();
        screen.render();
    });
}
