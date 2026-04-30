import * as blessed from 'blessed';

export interface DashboardScreenOptions {
    title: string;
    onQuit?: () => void;
}

export function createDashboardScreen(opts: DashboardScreenOptions): blessed.Widgets.Screen {
    const screen = blessed.screen({
        smartCSR: true,
        title: opts.title,
        fullUnicode: true,
        autoPadding: true,
    });
    screen.key(['q', 'C-c'], () => {
        if (opts.onQuit) opts.onQuit();
        screen.destroy();
    });

    return screen;
}

export async function awaitScreenDestroy(screen: blessed.Widgets.Screen): Promise<void> {
    await new Promise<void>((resolve) => {
        screen.once('destroy', () => resolve());
    });
}

/**
 * Wires `[` `]` for ±small jumps and `{` `}` (and `S-[` `S-]`) for ±large.
 * Uses a getter so the bound list/tree may be replaced without rewiring.
 */
export function attachJumpKeys(
    target: blessed.Widgets.BlessedElement,
    onJump: (delta: number) => void,
    opts: { small?: number; large?: number } = {},
): void {
    const small = opts.small ?? 10;
    const large = opts.large ?? 100;
    target.key([']'], () => onJump(small));
    target.key(['['], () => onJump(-small));
    target.key(['}', 'S-]'], () => onJump(large));
    target.key(['{', 'S-['], () => onJump(-large));
}

/**
 * Standard `g`/`S-g` jump-to-top/bottom for a blessed.list-like element.
 */
export function attachTopBottomKeys(
    target: blessed.Widgets.BlessedElement,
    bounds: { top: () => void; bottom: () => void },
): void {
    target.key(['g'], () => bounds.top());
    target.key(['S-g', 'G'], () => bounds.bottom());
}

/**
 * Pause a blessed screen so the underlying tty can be used for an external
 * full-screen process (e.g. `nvim`). Returns a function that restores the
 * blessed screen.
 */
export function pauseScreen(screen: blessed.Widgets.Screen): () => void {
    const program = (screen as unknown as {
        program: {
            normalBuffer: () => void;
            alternateBuffer: () => void;
            showCursor: () => void;
            hideCursor: () => void;
            disableMouse: () => void;
            enableMouse: () => void;
            pause: () => () => void;
        };
    }).program;
    let resume: (() => void) | undefined;
    try {
        resume = program.pause();
        program.normalBuffer();
        program.showCursor();
        program.disableMouse();
    } catch { /* ignore */ }

    return () => {
        try {
            program.alternateBuffer();
            program.enableMouse();
            program.hideCursor();
            if (resume) resume();
        } catch { /* ignore */ }
        screen.alloc();
        screen.render();
    };
}

import { spawn } from 'child_process';

/**
 * Run an external command with stdio inherited, while a blessed screen is
 * paused. Restores the screen on exit.
 */
export async function runInherit(
    cmd: string,
    args: string[],
    screen: blessed.Widgets.Screen,
): Promise<void> {
    return new Promise((resolve) => {
        const restore = pauseScreen(screen);
        const p = spawn(cmd, args, { stdio: 'inherit' });
        p.on('close', () => { restore(); resolve(); });
        p.on('error', () => { restore(); resolve(); });
    });
}

/**
 * Temporarily detach all `screen.key()`-registered handlers for the given
 * keys (so a modal can claim them) and return a function that restores the
 * original handlers.
 */
export function pauseScreenKeys(
    screen: blessed.Widgets.Screen,
    keys: string[],
): () => void {
    const emitter = screen as unknown as {
        listeners: (e: string) => Array<(...a: unknown[]) => void>;
        removeAllListeners: (e: string) => void;
        on: (e: string, l: (...a: unknown[]) => void) => void;
    };
    const saved: Record<string, Array<(...a: unknown[]) => void>> = {};
    for (const k of keys) {
        const evt = `key ${k}`;
        saved[evt] = emitter.listeners(evt).slice();
        emitter.removeAllListeners(evt);
    }

    return () => {
        for (const evt of Object.keys(saved)) {
            emitter.removeAllListeners(evt);
            for (const l of saved[evt]) emitter.on(evt, l);
        }
    };
}

export interface PickModalOptions {
    title: string;
    items: string[];
    /** Lines shown in a small panel beside the modal (e.g. visited files). */
    visited?: string[];
}

export interface PickFileModalResult {
    file: string;
    fromVisited: boolean;
}

/**
 * Show a centred modal list inside an existing blessed screen and return
 * the picked item (or null on cancel). Does NOT create a second screen.
 *
 * Features:
 *  - type-to-filter (case-insensitive substring)
 *  - Tab cycles focus between the main list and the visited list
 *  - Enter on the visited list re-views that file (returns fromVisited:true)
 *  - Esc / q cancels and returns null
 */
export async function pickFileModal(
    screen: blessed.Widgets.Screen,
    opts: PickModalOptions,
): Promise<PickFileModalResult | null> {
    return new Promise((resolve) => {
        const visited = opts.visited ?? [];
        const hasVisited = visited.length > 0;
        if (opts.items.length === 0 && !hasVisited) {
            resolve(null);

            return;
        }

        const restoreKeys = pauseScreenKeys(screen, ['tab', 'S-tab', 'escape', 'q']);
        const savedFocus = screen.focused;

        const showMain = opts.items.length > 0;
        const mainWidth = hasVisited && showMain ? '50%' : '70%';
        const mainLeft = hasVisited && showMain ? '5%' : 'center';
        const visitedLeft = showMain ? '55%' : 'center';
        const visitedWidth = showMain ? '45%' : '70%';

        const container = blessed.box({
            parent: screen,
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            tags: false,
            ch: ' ',
            style: { bg: 'black' },
        });
        container.setFront();
        const inner = blessed.box({
            parent: container,
            top: 'center',
            left: 'center',
            width: hasVisited && showMain ? '90%' : '70%',
            height: '70%',
            tags: false,
            style: { bg: 'black' },
        });

        const search = showMain ? blessed.box({
            parent: inner,
            label: ' filter (type to filter • tab → visited • esc back) ',
            top: 0,
            left: mainLeft,
            width: mainWidth,
            height: 3,
            tags: false,
            border: { type: 'line' },
            style: { border: { fg: 'magenta' }, bg: 'black', fg: 'white' },
        }) : null;

        const list = showMain ? blessed.list({
            parent: inner,
            label: ` ${opts.title} `,
            top: 3,
            left: mainLeft,
            width: mainWidth,
            height: '100%-3',
            keys: false,
            vi: false,
            mouse: true,
            tags: false,
            border: { type: 'line' },
            scrollbar: { ch: ' ', style: { bg: 'magenta' } },
            style: {
                bg: 'black',
                fg: 'white',
                border: { fg: 'magenta' },
                selected: { bg: 'magenta', fg: 'white', bold: true },
                item: { fg: 'white', bg: 'black' },
            },
            items: [...opts.items],
        }) : null;
        const visitedList = hasVisited ? blessed.list({
            parent: inner,
            label: ` viewed (${visited.length}) — enter to re-view • tab → list • esc back `,
            top: 0,
            left: visitedLeft,
            width: visitedWidth,
            height: '100%',
            keys: false,
            vi: false,
            mouse: true,
            tags: false,
            border: { type: 'line' },
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: {
                border: { fg: 'gray' },
                selected: { bg: 'gray', fg: 'white', bold: true },
                item: { fg: 'gray' },
                bg: 'black',
            },
            items: [...visited],
        }) : null;

        let filterText = '';
        let filtered = [...opts.items];
        const applyFilter = (q: string): void => {
            if (!list || !search) return;
            filterText = q;
            const ql = q.toLowerCase();
            filtered = ql ? opts.items.filter(i => i.toLowerCase().includes(ql)) : [...opts.items];
            list.clearItems();
            list.setItems(filtered.length ? filtered : ['<no matches>']);
            list.select(0);
            search.setContent(q ? ` ${q}` : ' (type to filter) ');
            screen.realloc();
            screen.render();
        };
        if (showMain) applyFilter('');

        let done = false;
        const close = (val: PickFileModalResult | null): void => {
            if (done) return;
            done = true;
            container.destroy();
            restoreKeys();
            try { savedFocus.focus(); } catch { /* ignore */ }
            screen.render();
            resolve(val);
        };

        const attachWrappedListKeys = (
            target: blessed.Widgets.ListElement,
            getCount: () => number,
        ): void => {
            const select = (idx: number): void => {
                target.select(idx);
                screen.render();
            };
            const moveBy = (delta: number): void => {
                const total = getCount();
                if (total === 0) return;
                const cur = (target as unknown as { selected?: number }).selected ?? 0;
                const next = Math.abs(delta) === 1
                    ? (cur + delta + total) % total
                    : Math.max(0, Math.min(total - 1, cur + delta));
                select(next);
            };

            target.key(['up', 'k'], () => moveBy(-1));
            target.key(['down', 'j'], () => moveBy(1));
            target.key(['pageup'], () => moveBy(-10));
            target.key(['pagedown'], () => moveBy(10));
            target.key(['g'], () => select(0));
            target.key(['S-g', 'G'], () => {
                const total = getCount();
                if (total === 0) return;
                select(total - 1);
            });
        };

        if (list) {
            attachWrappedListKeys(list, () => (filtered.length > 0 ? filtered.length : 1));
            const submitListSelection = (): void => {
                const idx = (list as unknown as { selected?: number }).selected ?? 0;
                const v = filtered[idx];
                if (!v || v === '<no matches>') return;
                close({ file: v, fromVisited: false });
            };
            list.key(['tab'], () => { if (visitedList) { visitedList.focus(); screen.render(); } });
            list.key(['escape'], () => close(null));
            list.key(['enter'], () => submitListSelection());
            list.on('keypress', (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
                if (!key) return;
                if (key.name === 'tab' || key.name === 'escape' || key.name === 'enter') return;
                if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown') return;
                if (key.name === 'j' || key.name === 'k' || key.name === 'g') return;
                if (key.name === 'backspace') {
                    applyFilter(filterText.slice(0, -1));

                    return;
                }
                if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= ' ') {
                    applyFilter(filterText + ch);
                }
            });
            list.on('select', () => submitListSelection());
        }

        if (visitedList) {
            attachWrappedListKeys(visitedList, () => visited.length);
            const submitVisitedSelection = (): void => {
                const idx = (visitedList as unknown as { selected?: number }).selected ?? 0;
                const v = visited[idx];
                if (v) close({ file: v, fromVisited: true });
            };
            visitedList.key(['tab'], () => { if (list) { list.focus(); screen.render(); } else close(null); });
            visitedList.key(['escape'], () => close(null));
            visitedList.key(['enter'], () => submitVisitedSelection());
            visitedList.on('select', () => submitVisitedSelection());
        }

        if (list) list.focus();
        else if (visitedList) visitedList.focus();
        screen.render();
    });
}

/**
 * Backwards-compatible simple picker (no search, no visited). Kept for
 * callers that just need a quick modal list.
 */
export async function pickModal(
    screen: blessed.Widgets.Screen,
    opts: PickModalOptions | string,
    legacyItems?: string[],
): Promise<string | null> {
    const o: PickModalOptions = typeof opts === 'string'
        ? { title: opts, items: legacyItems ?? [] }
        : opts;
    const r = await pickFileModal(screen, o);

    return r ? r.file : null;
}

export interface BrowseFilesOptions {
    /** Title shown in the modal label (count is appended automatically). */
    title: string;
    /** Initial file list. */
    files: string[];
    /**
     * Open the file (e.g. spawn nvim). Return `false` to keep the file in
     * `remaining` (e.g. unresolved conflict); return `true` / `void` to mark
     * it visited. Re-views from the visited panel never re-mark.
     */
    view: (file: string) => Promise<boolean | void>;
}

/**
 * Per-file split-diff browser used by git stash / git log / git view-changed /
 * git conflicts. Tracks `remaining` and `visited`, loops on the existing
 * `screen` until the user escapes.
 */
export async function browseFiles(
    screen: blessed.Widgets.Screen,
    opts: BrowseFilesOptions,
): Promise<void> {
    if (opts.files.length === 0) return;
    const remaining = new Set(opts.files);
    const visited: string[] = [];
    for (; ;) {
        const items = [...remaining].sort();
        const r = await pickFileModal(screen, {
            title: `${opts.title} (${items.length} left, ${visited.length} viewed)`,
            items,
            visited,
        });
        if (r === null) return;
        const ok = await opts.view(r.file);
        if (!r.fromVisited && ok !== false) {
            remaining.delete(r.file);
            visited.push(r.file);
        }
    }
}

/**
 * Run a function with a temporary blessed screen, cleaning it up afterwards.
 * Use this from commands that don't already own a dashboard screen.
 */
export async function withTempScreen<T>(
    title: string,
    fn: (screen: blessed.Widgets.Screen) => Promise<T>,
): Promise<T> {
    const screen = createDashboardScreen({ title });
    try {
        return await fn(screen);
    } finally {
        try { screen.destroy(); } catch { /* already destroyed */ }
    }
}
