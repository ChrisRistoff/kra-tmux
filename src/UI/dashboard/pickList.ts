import * as blessed from 'blessed';
import { escTag } from './escTag';
import { attachFocusCycleKeys } from './focus';
import { createDashboardShell } from './shell';
import { createDashboardScreen } from './screen';
import {
    attachVerticalNavigation,
    createDashboardFooter,
    createDashboardHeader,
    createDashboardTextPanel,
    setCenteredContent,
} from './widgets';

export interface PickListAction {
    /** Unique identifier returned in PickListResult.action when triggered. */
    id: string;
    /** Keys that trigger this action (blessed key names). */
    keys: string[];
    /** Footer chip label (e.g. 'd days'). */
    label: string;
    /**
     * Optional in-place handler. When provided, the action runs inside the
     * picker (the picker stays open) instead of exiting. Receives the
     * currently-highlighted item (or null), the blessed screen so the
     * handler can pause the screen and launch external processes, and a
     * `ctx` object whose `setItems` lets the handler mutate the visible
     * list (used for in-place multi-select toggle markers).
     */
    run?: (
        item: string | null,
        screen: import('blessed').Widgets.Screen,
        ctx: { setItems: (items: string[]) => void; finish: (value: string | null, action?: string) => void },
    ) => Promise<void> | void;
}

export interface PickListOptions {
    title: string;
    /** Header label shown above the list (single line). Falls back to `title`. */
    header?: string;
    items: string[];
    /** Allow blessed tags in list rows. Requires renderItem to emit tagged strings. */
    itemsUseTags?: boolean;
    /** Optional list-row renderer so menus can keep raw values but color the visible rows. */
    renderItem?: (item: string, index: number) => string;
    /** Optional details callback rendered in the right-hand side panel. */
    details?: (item: string, index: number) => string | Promise<string>;
    /** Allow blessed tags in the main details panel content. */
    detailsUseTags?: boolean;
    /** Optional secondary panel rendered below the main details panel. */
    secondaryDetails?: (item: string, index: number) => string | Promise<string>;
    /** Allow blessed tags in the secondary details panel content. */
    secondaryDetailsUseTags?: boolean;
    /** Label for the optional secondary panel. */
    secondaryLabel?: string;
    /** Footer chip text (right-aligned). Defaults to a standard hint. */
    footerChips?: string;
    /** Pre-selected item value. */
    selected?: string;
    /** When false, hides the right-hand details panel. Default true. */
    showDetailsPanel?: boolean;
    /** Extra key bindings that exit the picker with PickListResult.action set. */
    actions?: PickListAction[];
    /** Called when an item is highlighted (not selected). Useful for sliding window loads. */
    onHighlight?: (index: number, value: string) => void;
    /** When set, only show this many items at first; load more on scroll/jump. */
    pageSize?: number;
    /** When true, pressing enter in the search box submits the current query. */
    submitSearchQuery?: boolean;
    /**
     * Gate Enter / `select` events. When provided and returns false for the
     * currently-highlighted item, the picker will NOT resolve. Useful for
     * multi-select-style pickers where regular rows are toggle targets and
     * only sentinel rows (e.g. "Done" / "Cancel") may finish the picker.
     */
    canSubmit?: (value: string, index: number) => boolean;
}

export interface PickListResult {
    /** Selected item value, or null when the user cancelled. */
    value: string | null;
    /** Action id when an action key was pressed. */
    action?: string;
    /** Current search query, when the picker returns it. */
    query?: string;
}

const DEFAULT_FOOTER =
    'tab cycle · ↑/↓ navigate · enter select · s// search · [/] ±10 · {/} ±100 · g/G top/bottom · q cancel';

export async function pickList(opts: PickListOptions): Promise<PickListResult> {
    return new Promise<PickListResult>((resolve) => {
        const screen = createDashboardScreen({ title: opts.title });

        const items: string[] = opts.items.length ? opts.items.slice() : ['<no items>'];
        const showDetails = (opts.showDetailsPanel ?? true)
            && Boolean(opts.details ?? opts.secondaryDetails);

        const headerText = opts.header ?? opts.title;
        const detailsLoader = opts.details;
        const secondaryDetailsLoader = opts.secondaryDetails;
        const base = opts.footerChips ?? DEFAULT_FOOTER;
        const extra = (opts.actions ?? []).map((a) => a.label).join(' · ');
        const shell = createDashboardShell({
            screen,
            headerContent: `{center}{bold}${escTag(headerText)}{/bold}{/center}`,
            listLabel: opts.title,
            listFocusName: 'list',
            listWidth: showDetails ? '40%' : '100%',
            listItems: [],
            listTags: opts.itemsUseTags ?? false,
            search: {
                label: 'search',
                width: showDetails ? '40%' : '100%',
                inputOnFocus: true,
                keys: false,
            },
            detailPanels: showDetails
                ? [
                    { label: 'details', focusName: 'details', tags: true },
                    ...(secondaryDetailsLoader
                        ? [{ label: opts.secondaryLabel ?? 'context', focusName: opts.secondaryLabel ?? 'context', tags: true }]
                        : []),
                ]
                : [],
            keymapText: () => (extra ? `${base} · ${extra}` : base),
        });
        const { list, detailPanels, ring } = shell;
        const searchBox = shell.searchBox;
        if (!searchBox) throw new Error('pickList requires a search box');
        const details = showDetails ? detailPanels[0] ?? null : null;
        const secondaryDetails = showDetails && secondaryDetailsLoader ? detailPanels[1] ?? null : null;
        const listSel = (): number => (list as unknown as { selected?: number }).selected ?? 0;

        let filterQuery = '';
        let filtered = items.slice();
        const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : 0;
        let windowEnd = pageSize > 0 ? Math.min(pageSize, filtered.length) : filtered.length;
        const displayed = (): string[] => {
            const visible = pageSize > 0 ? filtered.slice(0, windowEnd) : filtered;
            const renderItem = opts.renderItem;
            if (!renderItem) return visible;

            return visible.map((item, index) => renderItem(item, index));
        };
        const ensureWindowAtLeast = (n: number): void => {
            if (pageSize <= 0) return;
            if (windowEnd >= n || windowEnd >= filtered.length) return;
            windowEnd = Math.min(filtered.length, Math.max(n, windowEnd + pageSize));
            list.setItems(displayed());
        };
        list.setItems(displayed());

        const detailsToken = { current: 0 };
        const secondaryDetailsToken = { current: 0 };
        const loadPanel = (
            panel: blessed.Widgets.BoxElement | null,
            loader: ((item: string, index: number) => string | Promise<string>) | undefined,
            allowTags: boolean,
            tokenRef: { current: number },
            value: string,
            idx: number,
        ): void => {
            if (!panel || !loader) return;
            const myToken = ++tokenRef.current;
            try {
                const out = loader(value, idx);
                if (typeof out === 'string') {
                    panel.setContent(allowTags ? out : escTag(out));
                    screen.render();
                } else {
                    panel.setContent('{gray-fg}loading…{/gray-fg}');
                    screen.render();
                    out.then((text) => {
                        if (myToken !== tokenRef.current) return;
                        panel.setContent(allowTags ? text : escTag(text));
                        screen.render();
                    }).catch((err: unknown) => {
                        if (myToken !== tokenRef.current) return;
                        const msg = err instanceof Error ? err.message : String(err);
                        panel.setContent(`{red-fg}${escTag(msg)}{/red-fg}`);
                        screen.render();
                    });
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                panel.setContent(`{red-fg}${escTag(msg)}{/red-fg}`);
                screen.render();
            }
        };
        const refreshDetails = (): void => {
            const idx = listSel();
            const value = filtered[idx];
            if (value === '<no items>' || value === '<no matches>') {
                if (details) details.setContent('');
                if (secondaryDetails) secondaryDetails.setContent('');
                screen.render();

                return;
            }
            loadPanel(details, detailsLoader, opts.detailsUseTags ?? false, detailsToken, value, idx);
            loadPanel(
                secondaryDetails,
                secondaryDetailsLoader,
                opts.secondaryDetailsUseTags ?? false,
                secondaryDetailsToken,
                value,
                idx,
            );
        };

        const applyFilter = (raw: string): void => {
            filterQuery = raw;
            const term = raw.toLowerCase();
            filtered = term.trim().length === 0
                ? items.slice()
                : items.filter((s) => s.toLowerCase().includes(term));
            if (filtered.length === 0) filtered = ['<no matches>'];
            windowEnd = pageSize > 0 ? Math.min(pageSize, filtered.length) : filtered.length;
            list.clearItems();
            list.setItems(displayed());
            list.select(0);
            refreshDetails();
            screen.realloc();
            screen.render();
        };

        if (opts.selected) {
            const idx = items.indexOf(opts.selected);
            if (idx >= 0) list.select(idx);
        }

        const finish = (val: string | null, action?: string, query?: string): void => {
            try { screen.destroy(); } catch { /* noop */ }
            resolve({ value: val, ...(action ? { action } : {}), ...(query !== undefined ? { query } : {}) });
        };

        const submit = (): void => {
            const idx = listSel();
            const v = filtered[idx];
            if (!v || v === '<no items>' || v === '<no matches>') return;
            if (opts.canSubmit && !opts.canSubmit(v, idx)) return;
            finish(v);
        };

        list.on('select item', () => {
            refreshDetails();
            const idx = listSel();
            const v = filtered[idx];
            if (opts.onHighlight && v && v !== '<no items>' && v !== '<no matches>') {
                opts.onHighlight(idx, v);
            }
        });
        list.on('select', () => submit());

        searchBox.on('keypress', () => {
            setImmediate(() => {
                const value = searchBox.getValue();
                if (value !== filterQuery) applyFilter(value);
            });
        });
        searchBox.key(['enter'], () => {
            if (opts.submitSearchQuery) {
                const selected = filtered[listSel()];
                const value = selected && selected !== '<no items>' && selected !== '<no matches>'
                    ? selected
                    : null;
                finish(value, 'search-submit', searchBox.getValue());

                return;
            }
            ring.focusAt(0);
        });
        searchBox.key(['escape'], () => {
            searchBox.clearValue();
            if (filterQuery) applyFilter('');
            ring.focusAt(0);
        });

        list.key(['s', '/'], () => {
            searchBox.focus();
            searchBox.readInput();
        });

        const moveBy = (delta: number): void => {
            if (filtered.length === 0) return;
            if (pageSize <= 0 && Math.abs(delta) === 1) {
                const count = displayed().length;
                if (count === 0) return;
                const next = (listSel() + delta + count) % count;
                list.select(next);
                refreshDetails();
                screen.render();

                return;
            }
            const cap = filtered.length - 1;
            let next = Math.min(cap, Math.max(0, listSel() + delta));
            ensureWindowAtLeast(next + 1);
            next = Math.min(displayed().length - 1, next);
            list.select(next);
            refreshDetails();
            screen.render();
        };

        attachVerticalNavigation(list, {
            moveBy,
            top: () => {
                if (displayed().length === 0) return;
                list.select(0);
                refreshDetails();
                screen.render();
            },
            bottom: () => {
                if (displayed().length === 0) return;
                if (pageSize > 0) {
                    windowEnd = filtered.length;
                    list.setItems(displayed());
                }
                list.select(Math.max(0, displayed().length - 1));
                refreshDetails();
                screen.render();
            },
            submit,
            cancel: () => finish(null),
        });

        const setItems = (next: string[]): void => {
            const prevIdx = listSel();
            items.length = 0;
            items.push(...(next.length ? next : ['<no items>']));
            applyFilter(filterQuery);
            const cap = Math.max(0, displayed().length - 1);
            list.select(Math.min(prevIdx, cap));
            refreshDetails();
            screen.render();
        };

        for (const action of opts.actions ?? []) {
            list.key(action.keys, () => {
                const v = filtered[listSel()];
                const cur = (v && v !== '<no items>' && v !== '<no matches>') ? v : null;
                if (action.run) {
                    void Promise.resolve(action.run(cur, screen, { setItems, finish })).then(() => {
                        try { ring.focusAt(0); refreshDetails(); screen.render(); } catch { /* ignore */ }
                    });

                    return;
                }
                finish(cur, action.id);
            });
        }

        attachFocusCycleKeys(screen, ring);
        ring.focusAt(0);
        refreshDetails();
    });
}

export interface ConfirmDashboardOptions {
    title: string;
    prompt: string;
    /** Optional details rendered above the buttons. */
    details?: string;
    /** Default focus. Defaults to 'no' for safety. */
    defaultChoice?: 'yes' | 'no';
}

/**
 * Standalone yes/no confirmation screen (creates and destroys its own blessed.screen).
 * Use modalConfirm() instead when you already have a parent screen.
 */
export async function confirmDashboard(opts: ConfirmDashboardOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const screen = createDashboardScreen({ title: opts.title });

        let selected: 'yes' | 'no' = opts.defaultChoice ?? 'no';

        createDashboardHeader(screen, {
            content: `{center}{bold}${escTag(opts.title)}{/bold}{/center}`,
        });

        createDashboardTextPanel(screen, {
            label: 'prompt',
            top: 3,
            left: 'center',
            width: '80%',
            bottom: 8,
            borderColor: 'cyan',
            scrollbarColor: 'cyan',
            content:
                `{bold}${escTag(opts.prompt)}{/bold}` +
                (opts.details ? `\n\n${escTag(opts.details)}` : ''),
            keys: false,
            vi: false,
        });

        const yesBtn = blessed.box({
            parent: screen,
            bottom: 4, left: '25%-16', width: 32, height: 3,
            tags: true,
            border: { type: 'line' },
            content: '{center}{bold}Yes (y){/bold}{/center}',
            style: { border: { fg: 'green' }, fg: 'green', bg: 'black' },
        } as unknown as blessed.Widgets.BoxOptions);

        const noBtn = blessed.box({
            parent: screen,
            bottom: 4, left: '75%-16', width: 32, height: 3,
            tags: true,
            border: { type: 'line' },
            content: '{center}{bold}No (n){/bold}{/center}',
            style: { border: { fg: 'red' }, fg: 'red', bg: 'black' },
        } as unknown as blessed.Widgets.BoxOptions);

        const footer = createDashboardFooter(screen);
        setCenteredContent(footer, 'y/n decide · ←/→ toggle · enter confirm · esc/q cancel');

        const paint = (): void => {
            const yStyle = yesBtn.style as { border: { fg: string }; fg: string; bg: string };
            const nStyle = noBtn.style as { border: { fg: string }; fg: string; bg: string };
            if (selected === 'yes') {
                yStyle.border.fg = 'white'; yStyle.fg = 'black'; yStyle.bg = 'green';
                nStyle.border.fg = 'red'; nStyle.fg = 'red'; nStyle.bg = 'black';
            } else {
                yStyle.border.fg = 'green'; yStyle.fg = 'green'; yStyle.bg = 'black';
                nStyle.border.fg = 'white'; nStyle.fg = 'black'; nStyle.bg = 'red';
            }
            screen.render();
        };

        const finish = (val: boolean): void => {
            try { screen.destroy(); } catch { /* noop */ }
            resolve(val);
        };

        screen.key(['y', 'Y'], () => finish(true));
        screen.key(['n', 'N'], () => finish(false));
        screen.key(['escape', 'q', 'C-c'], () => finish(false));
        screen.key(['left', 'right', 'h', 'l', 'tab'], () => {
            selected = selected === 'yes' ? 'no' : 'yes';
            paint();
        });
        screen.key(['enter', 'space'], () => finish(selected === 'yes'));

        paint();
    });
}

export interface InputDashboardOptions {
    title: string;
    prompt: string;
    initial?: string;
    /** Optional contextual details rendered below the prompt. */
    details?: string;
}

export async function inputDashboard(opts: InputDashboardOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        const screen = createDashboardScreen({ title: opts.title });

        createDashboardHeader(screen, {
            content: `{center}{bold}${escTag(opts.title)}{/bold}{/center}`,
        });

        createDashboardTextPanel(screen, {
            label: 'prompt',
            top: 3,
            left: 'center',
            width: '80%',
            height: '40%',
            borderColor: 'cyan',
            scrollbarColor: 'cyan',
            content:
                `{bold}${escTag(opts.prompt)}{/bold}` +
                (opts.details ? `\n\n${escTag(opts.details)}` : ''),
            keys: false,
            vi: false,
        });

        const input = blessed.textbox({
            parent: screen,
            bottom: 4,
            left: 'center',
            width: '80%',
            height: 3,
            border: { type: 'line' },
            inputOnFocus: true,
            keys: true,
            mouse: true,
            label: ' input ',
            style: { fg: 'white', bg: 'black', border: { fg: 'magenta' } },
        });

        const footer = createDashboardFooter(screen);
        setCenteredContent(footer, 'enter submit · esc/C-c cancel');

        if (opts.initial) input.setValue(opts.initial);

        const finish = (val: string | null): void => {
            try { screen.destroy(); } catch { /* noop */ }
            resolve(val);
        };

        input.key(['escape', 'C-c'], () => finish(null));
        input.key(['enter'], () => finish(input.getValue()));
        input.on('submit', () => finish(input.getValue()));
        input.on('cancel', () => finish(null));

        input.focus();
        input.readInput();
        screen.render();
    });
}
