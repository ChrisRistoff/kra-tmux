import * as blessed from 'blessed';
import { createFocusRing, type FocusRing } from './focus';
import {
    createDashboardFooter,
    createDashboardHeader,
    createDashboardList,
    createDashboardSearchBox,
    createDashboardTextPanel,
} from './widgets';

type Dimension = number | string;

const PANEL_COLORS = [
    { border: 'yellow', scrollbar: 'cyan', focus: 'yellow' },
    { border: 'green', scrollbar: 'cyan', focus: 'green' },
    { border: 'magenta', scrollbar: 'magenta', focus: 'magenta' },
] as const;

interface PanelPlacement {
    top: Dimension;
    height?: Dimension;
    bottom?: Dimension;
}

function getDefaultPlacement(index: number, total: number): PanelPlacement {
    if (total <= 1) {
        return { top: 3, bottom: 3 };
    }
    if (total === 2) {
        return index === 0
            ? { top: 3, height: '40%' }
            : { top: '40%+3', bottom: 3 };
    }

    return index === 0
        ? { top: 3, height: '40%' }
        : index === 1
            ? { top: '40%+3', height: '30%-3' }
            : { top: '70%', bottom: 3 };
}

export interface DashboardShellSearchOptions {
    label?: string;
    width?: Dimension;
    right?: Dimension;
    inputOnFocus?: boolean;
    keys?: boolean;
    mouse?: boolean;
    borderColor?: string;
}

export interface DashboardShellPanelOptions {
    label: string;
    focusName?: string;
    tags?: boolean;
    content?: string;
    top?: Dimension;
    height?: Dimension;
    bottom?: Dimension;
    borderColor?: string;
    scrollbarColor?: string;
    wrap?: boolean;
}

export interface DashboardShellOptions {
    screen: blessed.Widgets.Screen;
    parent?: blessed.Widgets.Node;
    headerContent?: string;
    listLabel: string;
    listFocusName?: string;
    listWidth?: Dimension;
    listItems?: string[];
    listTags?: boolean;
    listKeys?: boolean;
    listVi?: boolean;
    search?: false | DashboardShellSearchOptions;
    detailPanels?: DashboardShellPanelOptions[];
    keymapText: string | (() => string);
}

export interface DashboardShell {
    header: blessed.Widgets.BoxElement;
    footer: blessed.Widgets.BoxElement;
    searchBox: blessed.Widgets.TextboxElement | null;
    list: blessed.Widgets.ListElement;
    detailPanels: blessed.Widgets.BoxElement[];
    ring: FocusRing;
}

export function createDashboardShell(opts: DashboardShellOptions): DashboardShell {
    const parent = opts.parent ?? opts.screen;
    const detailPanels = opts.detailPanels ?? [];
    const listWidth = opts.listWidth ?? (detailPanels.length > 0 ? '40%' : '100%');

    const header = createDashboardHeader(parent, {
        content: opts.headerContent ?? '',
    });

    const searchBox = opts.search === false
        ? null
        : createDashboardSearchBox(parent, {
            ...(opts.search?.label !== undefined ? { label: opts.search.label } : {}),
            top: 3,
            left: 0,
            ...(opts.search?.right !== undefined ? { right: opts.search.right } : {}),
            ...(opts.search?.width !== undefined ? { width: opts.search.width } : { width: listWidth }),
            ...(opts.search?.borderColor !== undefined ? { borderColor: opts.search.borderColor } : {}),
            inputOnFocus: opts.search?.inputOnFocus ?? true,
            keys: opts.search?.keys ?? false,
            mouse: opts.search?.mouse ?? true,
        });

    const list = createDashboardList(parent, {
        label: opts.listLabel,
        top: searchBox ? 6 : 3,
        left: 0,
        width: listWidth,
        bottom: 3,
        items: opts.listItems ?? [],
        tags: opts.listTags ?? true,
        keys: opts.listKeys ?? false,
        vi: opts.listVi ?? false,
        borderColor: 'cyan',
        scrollbarColor: 'magenta',
    });

    const createdPanels = detailPanels.map((panel, index) => {
        const placement = getDefaultPlacement(index, detailPanels.length);
        const color = PANEL_COLORS[Math.min(index, PANEL_COLORS.length - 1)];

        return createDashboardTextPanel(parent, {
            label: panel.label,
            top: panel.top ?? placement.top,
            left: listWidth,
            right: 0,
            ...(panel.height !== undefined
                ? { height: panel.height }
                : placement.height !== undefined
                    ? { height: placement.height }
                    : {}),
            ...(panel.bottom !== undefined
                ? { bottom: panel.bottom }
                : placement.bottom !== undefined
                    ? { bottom: placement.bottom }
                    : {}),
            borderColor: panel.borderColor ?? color.border,
            scrollbarColor: panel.scrollbarColor ?? color.scrollbar,
            tags: panel.tags ?? true,
            wrap: panel.wrap ?? true,
            content: panel.content ?? '',
        });
    });

    const footer = createDashboardFooter(parent, { content: '' });
    const ring = createFocusRing({
        screen: opts.screen,
        panels: [
            { el: list as blessed.Widgets.BlessedElement, name: opts.listFocusName ?? opts.listLabel, color: 'cyan' },
            ...createdPanels.map((panel, index) => ({
                el: panel as blessed.Widgets.BlessedElement,
                name: detailPanels[index].focusName ?? detailPanels[index].label,
                color: PANEL_COLORS[Math.min(index, PANEL_COLORS.length - 1)].focus,
            })),
        ],
        footer,
        keymapText: opts.keymapText,
    });

    return {
        header,
        footer,
        searchBox,
        list,
        detailPanels: createdPanels,
        ring,
    };
}
