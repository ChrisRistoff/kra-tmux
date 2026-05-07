import * as blessed from 'blessed';
import {
    awaitScreenDestroy,
    createDashboardScreen,
    type DashboardScreenOptions,
} from './screen';
import {
    attachFocusCycleKeys,
    type FocusRing,
} from './focus';
import {
    attachVerticalNavigation,
} from './widgets';
import {
    createDashboardShell,
    type DashboardShell,
    type DashboardShellPanelOptions,
    type DashboardShellSearchOptions,
} from './shell';
import {
    attachTreeExpandCollapseKeys,
    type ExpandableTreeRow,
} from './tree';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ListDetailPaintCtx<Row> {
    /** True when a newer paint has started for this panel; the painter must
     *  bail out without touching the screen. Check after every `await`. */
    isStale: () => boolean;
    api: ListDetailDashboardApi<Row>;
}

export interface ListDetailPanelSpec<Row> {
    label: string;
    focusName?: string;
    wrap?: boolean;
    tags?: boolean;
    borderColor?: string;
    scrollbarColor?: string;
    top?: string | number;
    height?: string | number;
    bottom?: string | number;
    /** Initial content shown before any selection. */
    initialContent?: string;
    /** Compute the panel content for the currently-selected row. May be sync
     *  or async. The helper will write the result into the panel and apply
     *  `scrollPerc(row)` (default 0). Return `null` to leave the panel as-is. */
    paint: (row: Row, ctx: ListDetailPaintCtx<Row>) => string | null | Promise<string | null>;
    /** Returns `0..100`. Defaults to `0`. */
    scrollPerc?: (row: Row) => number;
}

export interface ListDetailFilterSpec<Row> {
    label?: string;
    placeholder?: string;
    /** `'live'` re-applies on every keystroke (default).
     *  `'submit'` only applies on Enter. */
    mode?: 'live' | 'submit';
    match?: (row: Row, query: string) => boolean;
    /** Called whenever the live query changes (live mode only). */
    onChange?: (query: string, api: ListDetailDashboardApi<Row>) => void;
    /** Called when the user presses Enter inside the search box.
     *  In `submit` mode this is the only signal the dashboard receives. */
    onSubmit?: (query: string, api: ListDetailDashboardApi<Row>) => void | Promise<void>;
}

export interface ListDetailActionSpec<Row> {
    keys: string | string[];
    handler: (row: Row | undefined, api: ListDetailDashboardApi<Row>) => void | Promise<void>;
}

export interface ListDetailTreeSpec {
    expanded: Set<string>;
    /** Rebuild the row list (helper passes the id of the row to preserve
     *  selection on). */
    rebuild: (preserveId?: string) => void;
}

export interface ListDetailDashboardApi<Row> {
    screen: blessed.Widgets.Screen;
    shell: DashboardShell;
    rows: () => readonly Row[];
    /** Replace the row list. Selection is preserved by `rowKey` if possible. */
    setRows: (next: Row[], opts?: { preserveKey?: string | null }) => void;
    selectedIdx: () => number;
    selectedRow: () => Row | undefined;
    selectByIdx: (idx: number) => void;
    selectByKey: (key: string) => boolean;
    /** Force re-render of the list items (no row changes). */
    repaint: () => void;
    /** Force a repaint of all detail panels even if the row hasn't changed. */
    repaintDetails: () => void;
    refreshHeader: () => void;
    flashHeader: (msg: string, ms?: number) => void;
    destroy: () => void;
}

export interface CreateListDetailDashboardOptions<Row> {
    title: string;
    headerContent?: string | (() => string);
    keymapText: string | (() => string);

    // List config -----------------------------------------------------------
    listLabel?: string;
    listFocusName?: string;
    listWidth?: string | number;
    listTags?: boolean;

    // Data ------------------------------------------------------------------
    initialRows?: Row[];
    loadRows?: () => Promise<Row[]> | Row[];
    rowKey: (row: Row) => string;
    renderListItem: (row: Row, idx: number, isSelected: boolean) => string;

    // Optional features -----------------------------------------------------
    filter?: ListDetailFilterSpec<Row>;
    detailPanels: ListDetailPanelSpec<Row>[];
    actions?: ListDetailActionSpec<Row>[];
    tree?: ListDetailTreeSpec;

    // Behaviour knobs -------------------------------------------------------
    selectDebounceMs?: number;          // default 60
    /** Override the default cyclic moveBy (used by gitLog for lazy windows). */
    moveByOverride?: (
        delta: number,
        defaultMove: (delta: number) => void,
        api: ListDetailDashboardApi<Row>,
    ) => void;
    /** If provided, used in place of the default `top/bottom` jump handlers. */
    onJumpTop?: (api: ListDetailDashboardApi<Row>) => void;
    onJumpBottom?: (api: ListDetailDashboardApi<Row>) => void;

    // Lifecycle -------------------------------------------------------------
    /** Runs after the screen is built and the initial selection painted. */
    onReady?: (api: ListDetailDashboardApi<Row>) => void | Promise<void>;
    onSelectionChange?: (row: Row | undefined, api: ListDetailDashboardApi<Row>) => void;
    /** Optional pre-existing screen (rare). When omitted the helper creates one. */
    screen?: blessed.Widgets.Screen;
    /** Custom screen options when the helper creates the screen. */
    screenOptions?: Partial<DashboardScreenOptions>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export async function createListDetailDashboard<Row>(
    opts: CreateListDetailDashboardOptions<Row>,
): Promise<void> {
    const screen = opts.screen ?? createDashboardScreen({
        title: opts.title,
        ...(opts.screenOptions ?? {}),
    });

    let rows: Row[] = opts.initialRows ? opts.initialRows.slice() : [];
    if (opts.loadRows && rows.length === 0) {
        const loaded = await opts.loadRows();
        rows = loaded.slice();
    }

    let currentIdx = -1;
    let lastPaintedKey = '';
    let filterQuery = '';

    // Per-panel paint sequence numbers
    const paintSeqs: number[] = opts.detailPanels.map(() => 0);

    // ── Shell construction ──────────────────────────────────────────────────
    const search: false | DashboardShellSearchOptions = opts.filter
        ? {
            label: opts.filter.label ?? (opts.filter.mode === 'submit' ? 'search' : 'filter'),
            inputOnFocus: true,
            keys: false,
        }
        : false;

    const shellPanels: DashboardShellPanelOptions[] = opts.detailPanels.map((p) => ({
        label: p.label,
        ...(p.focusName !== undefined ? { focusName: p.focusName } : {}),
        ...(p.wrap !== undefined ? { wrap: p.wrap } : {}),
        ...(p.tags !== undefined ? { tags: p.tags } : {}),
        ...(p.borderColor !== undefined ? { borderColor: p.borderColor } : {}),
        ...(p.scrollbarColor !== undefined ? { scrollbarColor: p.scrollbarColor } : {}),
        ...(p.top !== undefined ? { top: p.top } : {}),
        ...(p.height !== undefined ? { height: p.height } : {}),
        ...(p.bottom !== undefined ? { bottom: p.bottom } : {}),
        ...(p.initialContent !== undefined ? { content: p.initialContent } : {}),
    }));

    const shell = createDashboardShell({
        screen,
        ...(typeof opts.headerContent === 'string' ? { headerContent: opts.headerContent } : {}),
        listLabel: opts.listLabel ?? 'items',
        ...(opts.listFocusName !== undefined ? { listFocusName: opts.listFocusName } : { listFocusName: opts.listLabel ?? 'items' }),
        listWidth: opts.listWidth ?? '40%',
        listItems: [],
        listTags: opts.listTags ?? true,
        search,
        detailPanels: shellPanels,
        keymapText: opts.keymapText,
    });

    const { header, list, ring, searchBox } = shell;
    const detailPanels = shell.detailPanels;

    // ── Header rendering ────────────────────────────────────────────────────
    function refreshHeader(): void {
        if (typeof opts.headerContent === 'function') {
            header.setContent(opts.headerContent());
        }
    }

    let flashTimer: NodeJS.Timeout | null = null;
    let savedHeader: string | null = null;
    function flashHeader(msg: string, ms = 1800): void {
        if (flashTimer === null) savedHeader = header.content as string;
        if (flashTimer) clearTimeout(flashTimer);
        header.setContent(msg);
        screen.render();
        flashTimer = setTimeout(() => {
            flashTimer = null;
            if (savedHeader !== null) header.setContent(savedHeader);
            savedHeader = null;
            refreshHeader();
            screen.render();
        }, ms);
        flashTimer.unref?.();
    }

    // ── List rendering / data ───────────────────────────────────────────────
    function visibleRows(): Row[] {
        if (!opts.filter || filterQuery === '' || !opts.filter.match) return rows;
        return rows.filter((r) => opts.filter!.match!(r, filterQuery));
    }

    let displayed: Row[] = visibleRows();

    function renderListItems(): void {
        list.setItems(displayed.map((r, i) => opts.renderListItem(r, i, i === currentIdx)));
    }

    function applyFilter(): void {
        const before = currentRow();
        displayed = visibleRows();
        renderListItems();
        if (displayed.length === 0) {
            currentIdx = -1;
            for (let i = 0; i < detailPanels.length; i++) detailPanels[i].setContent('');
            lastPaintedKey = '';
            screen.render();
            return;
        }
        let restoreIdx = 0;
        if (before) {
            const k = opts.rowKey(before);
            const found = displayed.findIndex((r) => opts.rowKey(r) === k);
            if (found >= 0) restoreIdx = found;
        }
        currentIdx = -1; // force a repaint
        list.select(restoreIdx);
        screen.render();
        void selectIndex(restoreIdx);
    }

    function currentRow(): Row | undefined {
        return currentIdx >= 0 && currentIdx < displayed.length ? displayed[currentIdx] : undefined;
    }

    // ── Detail painting ─────────────────────────────────────────────────────
    async function paintPanel(idx: number, row: Row): Promise<void> {
        const spec = opts.detailPanels[idx];
        const panel = detailPanels[idx];
        const seq = ++paintSeqs[idx];
        const ctx: ListDetailPaintCtx<Row> = {
            isStale: () => seq !== paintSeqs[idx],
            api,
        };
        let result: string | null;
        try {
            const r = spec.paint(row, ctx);
            result = r instanceof Promise ? await r : r;
        } catch (e) {
            if (ctx.isStale()) return;
            panel.setContent(`{red-fg}error:{/red-fg} ${(e as Error).message}`);
            screen.render();
            return;
        }
        if (ctx.isStale()) return;
        if (result === null) return;
        panel.setContent(result);
        const perc = spec.scrollPerc ? spec.scrollPerc(row) : 0;
        panel.setScrollPerc(perc);
        screen.render();
    }

    async function selectIndex(i: number): Promise<void> {
        if (i < 0 || i >= displayed.length) return;
        const row = displayed[i];
        const key = `${i}|${opts.rowKey(row)}`;
        if (key === lastPaintedKey && i === currentIdx) return;
        currentIdx = i;
        lastPaintedKey = key;
        if (opts.onSelectionChange) opts.onSelectionChange(row, api);
        await Promise.all(detailPanels.map((_p, idx) => paintPanel(idx, row)));
    }

    // ── API surface ─────────────────────────────────────────────────────────
    const api: ListDetailDashboardApi<Row> = {
        screen,
        shell,
        rows: () => rows,
        setRows: (next, options) => {
            rows = next.slice();
            const preserveKey = options?.preserveKey ?? (currentRow() ? opts.rowKey(currentRow()!) : null);
            displayed = visibleRows();
            renderListItems();
            if (displayed.length === 0) {
                currentIdx = -1;
                lastPaintedKey = '';
                for (let i = 0; i < detailPanels.length; i++) detailPanels[i].setContent('');
                screen.render();
                return;
            }
            let restore = 0;
            if (preserveKey) {
                const found = displayed.findIndex((r) => opts.rowKey(r) === preserveKey);
                if (found >= 0) restore = found;
            }
            currentIdx = -1;
            list.select(restore);
            screen.render();
            void selectIndex(restore);
        },
        selectedIdx: () => currentIdx,
        selectedRow: () => currentRow(),
        selectByIdx: (idx) => {
            if (idx < 0 || idx >= displayed.length) return;
            list.select(idx);
            screen.render();
            void selectIndex(idx);
        },
        selectByKey: (key) => {
            const idx = displayed.findIndex((r) => opts.rowKey(r) === key);
            if (idx < 0) return false;
            list.select(idx);
            screen.render();
            void selectIndex(idx);
            return true;
        },
        repaint: () => {
            renderListItems();
            screen.render();
        },
        repaintDetails: () => {
            lastPaintedKey = '';
            const row = currentRow();
            if (row !== undefined) {
                void Promise.all(detailPanels.map((_p, idx) => paintPanel(idx, row)));
            }
        },
        refreshHeader: () => {
            refreshHeader();
            screen.render();
        },
        flashHeader,
        destroy: () => {
            try { screen.destroy(); } catch { /* noop */ }
        },
    };

    // ── Initial paint ───────────────────────────────────────────────────────
    refreshHeader();
    renderListItems();

    // ── Selection wiring ────────────────────────────────────────────────────
    const debounceMs = opts.selectDebounceMs ?? 60;
    let selectTimer: NodeJS.Timeout | null = null;
    list.on('select item', (_item: unknown, idx: number) => {
        if (selectTimer) clearTimeout(selectTimer);
        selectTimer = setTimeout(() => {
            selectTimer = null;
            void selectIndex(idx);
        }, debounceMs);
    });

    // ── Vertical navigation ─────────────────────────────────────────────────
    function defaultMove(delta: number): void {
        if (displayed.length === 0) return;
        const cur = currentIdx >= 0 ? currentIdx : 0;
        let target = cur + delta;
        if (Math.abs(delta) === 1) {
            if (target < 0) target = displayed.length - 1;
            if (target >= displayed.length) target = 0;
        } else {
            if (target < 0) target = 0;
            if (target >= displayed.length) target = displayed.length - 1;
        }
        list.select(target);
        screen.render();
    }

    attachVerticalNavigation(list, {
        moveBy: (delta) => {
            if (opts.moveByOverride) {
                opts.moveByOverride(delta, defaultMove, api);
                return;
            }
            defaultMove(delta);
        },
        top: () => {
            if (opts.onJumpTop) { opts.onJumpTop(api); return; }
            if (displayed.length === 0) return;
            list.select(0);
            screen.render();
        },
        bottom: () => {
            if (opts.onJumpBottom) { opts.onJumpBottom(api); return; }
            if (displayed.length === 0) return;
            list.select(displayed.length - 1);
            screen.render();
        },
        cancel: () => api.destroy(),
    });

    // ── Filter wiring ───────────────────────────────────────────────────────
    if (opts.filter && searchBox) {
        const f = opts.filter;
        const mode = f.mode ?? 'live';
        if (mode === 'live') {
            searchBox.on('keypress', () => {
                setImmediate(() => {
                    const v = searchBox.getValue();
                    if (v === filterQuery) return;
                    filterQuery = v;
                    if (f.onChange) f.onChange(filterQuery, api);
                    if (f.match) applyFilter();
                });
            });
            searchBox.key(['enter'], () => {
                if (f.onSubmit) void f.onSubmit(filterQuery, api);
                list.focus();
            });
            searchBox.key(['escape'], () => {
                searchBox.clearValue();
                if (filterQuery !== '') {
                    filterQuery = '';
                    if (f.onChange) f.onChange('', api);
                    if (f.match) applyFilter();
                }
                list.focus();
            });
        } else {
            // submit mode — caller drives everything via onSubmit
            searchBox.key(['enter'], () => {
                filterQuery = searchBox.getValue();
                if (f.onSubmit) void f.onSubmit(filterQuery, api);
                list.focus();
            });
            searchBox.key(['escape'], () => {
                searchBox.clearValue();
                list.focus();
            });
        }
        const claimedKeys = new Set<string>();
        if (opts.actions) {
            for (const a of opts.actions) {
                const ks = Array.isArray(a.keys) ? a.keys : [a.keys];
                for (const k of ks) claimedKeys.add(k);
            }
        }
        const defaultFocusKeys = ['s', '/'].filter((k) => !claimedKeys.has(k));
        if (defaultFocusKeys.length > 0) {
            list.key(defaultFocusKeys, () => {
                searchBox.focus();
                screen.render();
            });
        }
    }

    // ── User-supplied actions ───────────────────────────────────────────────
    if (opts.actions) {
        for (const action of opts.actions) {
            const keys = Array.isArray(action.keys) ? action.keys : [action.keys];
            list.key(keys, () => {
                void action.handler(currentRow(), api);
            });
        }
    }

    // ── Tree mode ───────────────────────────────────────────────────────────
    if (opts.tree) {
        const treeOpts = opts.tree;
        attachTreeExpandCollapseKeys({
            tree: list as unknown as Parameters<
                typeof attachTreeExpandCollapseKeys<ExpandableTreeRow>
            >[0]['tree'],
            getRows: () => displayed as unknown as readonly ExpandableTreeRow[],
            getSelectedIndex: () => currentIdx,
            expanded: treeOpts.expanded,
            rebuild: (preserveId) => treeOpts.rebuild(preserveId),
            onSelect: (idx) => {
                currentIdx = idx;
                lastPaintedKey = '';
                const row = currentRow();
                if (row !== undefined) {
                    void Promise.all(detailPanels.map((_p, i) => paintPanel(i, row)));
                }
            },
        });
    }

    // ── Focus + lifecycle ───────────────────────────────────────────────────
    attachFocusCycleKeys(screen, ring as FocusRing);
    screen.on('resize', () => {
        renderListItems();
        screen.render();
    });

    ring.focusAt(0);
    screen.render();

    if (displayed.length > 0) {
        list.select(0);
        void selectIndex(0);
    }

    if (opts.onReady) await opts.onReady(api);

    await awaitScreenDestroy(screen);
}
