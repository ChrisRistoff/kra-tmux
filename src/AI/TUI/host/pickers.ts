/**
 * TUI implementations of the chat pickers. Everything lives as a
 * blessed overlay so the agent never has to surrender the screen —
 * file picker, confirms, popups and multi-select all render on top of
 * the existing chat screen.
 */

import * as blessed from 'blessed';
import * as fs from 'fs';
import * as path from 'path';
import {
    confirmModal,
    inputModal,
    multiSelectModal,
    showContextsPopupModal,
} from '../widgets/contextsModal';
import { blessedFilePicker } from '../widgets/filePickerModal';
import { BG_PRIMARY } from '../theme';

export interface FilePickerSelection {
    path: string;
    isDir: boolean;
}

export interface ChatPickers {
    pickFilesOrFolders: () => Promise<FilePickerSelection[] | null>;
    promptShareMode: () => Promise<'entire' | 'snippet' | null>;
    pickFileFromFolder: (folder: string) => Promise<string[] | null>;
    promptLineRange: (filePath: string, maxLine: number) => Promise<{ start: number; end: number } | null>;
    pickContextsToRemove: (displayItems: string[]) => Promise<number[] | null>;
    showContextsPopup: (title: string, lines: string[]) => Promise<void>;
    confirm: (title: string, body: string) => Promise<boolean>;
    notify: (message: string) => void;
}

export interface CreateTuiChatPickersOptions {
    screen: blessed.Widgets.Screen;
    /** Hook for status-bar feedback after pickers complete. */
    onNotify?: (msg: string) => void;
}

interface RepoRoot { alias: string; root: string }

function loadSelectedRepoRoots(): RepoRoot[] {
    const roots: RepoRoot[] = [];
    const roFile = process.env.KRA_SELECTED_REPO_ROOTS_FILE;
    if (roFile) {
        try {
            const raw = fs.readFileSync(roFile, 'utf8');
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
                for (const e of parsed) {
                    if (e && typeof e === 'object'
                        && typeof (e as { alias?: unknown }).alias === 'string'
                        && typeof (e as { root?: unknown }).root === 'string') {
                        roots.push({
                            alias: (e as { alias: string }).alias,
                            root: (e as { root: string }).root,
                        });
                    }
                }
            }
        } catch { /* ignore */ }
    }
    if (roots.length === 0 && process.env.KRA_SELECTED_REPO_ROOTS) {
        for (const line of process.env.KRA_SELECTED_REPO_ROOTS.split('\n')) {
            const m = line.match(/^([^\t]+)\t(.+)$/);
            if (m) roots.push({ alias: m[1], root: m[2] });
        }
    }

    return roots;
}

function enumerateRepo(root: string): string[] {
    const entries: string[] = [];
    const seen = new Set<string>();
    const add = (p: string): void => {
        if (!p || p === '.') return;
        if (seen.has(p)) return;
        seen.add(p);
        entries.push(p);
    };
    const isGit = fs.existsSync(path.join(root, '.git'));
    try {
        if (isGit) {
            const { execSync } = require('child_process') as typeof import('child_process');
            const out = execSync(
                'git ls-files --cached --others --exclude-standard',
                { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
            );
            for (const f of out.split('\n').filter(Boolean)) {
                const abs = path.join(root, f);
                add(abs);
                let dir = abs;
                 
                while (true) {
                    dir = path.dirname(dir);
                    if (!dir || dir === '/' || dir === '.' || dir === root) break;
                    if (!dir.startsWith(root + path.sep)) break;
                    add(dir);
                }
            }
            add(root);
        } else {
            const walk = (d: string): void => {
                let names: string[] = [];
                try { names = fs.readdirSync(d); } catch { return; }
                for (const n of names) {
                    if (n === '.git' || n === 'node_modules') continue;
                    const p = path.join(d, n);
                    let st: fs.Stats;
                    try { st = fs.statSync(p); } catch { continue; }
                    if (st.isDirectory()) { add(p); walk(p); }
                    else add(p);
                }
            };
            walk(root);
        }
    } catch { /* ignore */ }
    entries.sort();

    return entries;
}

function buildFileListInput(): { entries: string[]; cwd: string } {
    const repos = loadSelectedRepoRoots();
    const cwd = process.cwd();
    const all: string[] = [];
    if (repos.length > 0) {
        for (const r of repos) all.push(...enumerateRepo(r.root));
    } else {
        all.push(...enumerateRepo(cwd));
    }

    return { entries: all, cwd };
}

async function runFilePicker(
    screen: blessed.Widgets.Screen,
    inputLines: string[],
    cwd: string,
    title?: string,
): Promise<string[] | null> {
    if (inputLines.length === 0) return null;

    return blessedFilePicker(screen, inputLines, { cwd, title, multi: true });
}

export function createTuiChatPickers(opts: CreateTuiChatPickersOptions): ChatPickers {
    const { screen } = opts;
    let lastNotify = '';

    return {
        pickFilesOrFolders: async () => {
            const { entries, cwd } = buildFileListInput();
            const picked = await runFilePicker(screen, entries, cwd, 'pick files/folders');
            if (!picked) return null;
            const out: FilePickerSelection[] = [];
            const seen = new Set<string>();
            for (const raw of picked) {
                let abs = raw;
                if (!path.isAbsolute(abs)) abs = path.join(cwd, abs);
                abs = abs.replace(/\/$/, '');
                if (seen.has(abs)) continue;
                seen.add(abs);
                let isDir = false;
                try { isDir = fs.statSync(abs).isDirectory(); } catch { /* ignore */ }
                out.push({ path: abs, isDir });
            }

            return out.length > 0 ? out : null;
        },
        promptShareMode: async () => {
            const choice = await new Promise<string | null>((resolve) => {
                const list = blessed.list({
                    parent: screen,
                    label: ' add to context ',
                    top: 'center',
                    left: 'center',
                    width: '40%',
                    height: 5,
                    border: { type: 'line' },
                    keys: true,
                    vi: true,
                    mouse: true,
                    style: {
                        border: { fg: 'magenta' },
                        selected: { bg: 'magenta', fg: 'white', bold: true },
                        item: { fg: 'white' },
                        bg: BG_PRIMARY,
                    },
                    items: ['Entire', 'Snippet'],
                });
                const cleanup = (v: string | null): void => {
                    list.destroy();
                    screen.render();
                    resolve(v);
                };
                list.key(['escape', 'q', 'C-c'], () => cleanup(null));
                list.on('select', (_i, idx) => cleanup(idx === 0 ? 'entire' : 'snippet'));
                list.focus();
                screen.render();
            });

            return choice === 'entire' || choice === 'snippet' ? choice : null;
        },
        pickFileFromFolder: async (folder) => {
            // List files only (no dirs) inside the folder via the same fzf flow.
            const entries: string[] = [];
            const walk = (d: string): void => {
                let names: string[] = [];
                try { names = fs.readdirSync(d); } catch { return; }
                for (const n of names) {
                    if (n === '.git' || n === 'node_modules') continue;
                    const p = path.join(d, n);
                    let st: fs.Stats;
                    try { st = fs.statSync(p); } catch { continue; }
                    if (st.isDirectory()) walk(p);
                    else entries.push(p);
                }
            };
            walk(folder);
            const picked = await runFilePicker(screen, entries, folder, 'pick file');
            if (!picked) return null;
            const abs = picked.map((p) => path.isAbsolute(p) ? p : path.join(folder, p));

            return abs.length > 0 ? abs : null;
        },
        promptLineRange: async (filePath, maxLine) => {
            const raw = await inputModal(
                screen,
                `line range for ${path.basename(filePath)} (1..${maxLine})`,
                `1-${maxLine}`,
                'format: start-end · enter submit · esc cancel',
            );
            if (raw === null) return null;
            const trimmed = raw.trim();
            if (!trimmed) return null;
            const m = trimmed.match(/^(\d+)\s*[-:]\s*(\d+)$/) || trimmed.match(/^(\d+)$/);
            if (!m) return null;
            const start = parseInt(m[1], 10);
            const end = parseInt(m[2] ?? m[1], 10);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
            if (start < 1 || end < start || end > maxLine) return null;

            return { start, end };
        },
        pickContextsToRemove: async (displayItems) => {
            return multiSelectModal(screen, 'select context(s) to remove', displayItems);
        },
        showContextsPopup: async (title, lines) => {
            await showContextsPopupModal(screen, title, lines);
        },
        confirm: async (title, body) => {
            return confirmModal(screen, title, body);
        },
        notify: (msg) => {
            lastNotify = msg;
            if (opts.onNotify) opts.onNotify(msg);
            // also retain for debugging
            void lastNotify;
        },
    };
}
