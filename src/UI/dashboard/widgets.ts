import * as blessed from 'blessed';
import { escTag } from './escTag';
import { attachJumpKeys, attachTopBottomKeys } from './screen';

type Dimension = number | string;

type KeyTarget = blessed.Widgets.BlessedElement & {
    key: (keys: string[] | string, handler: () => void) => unknown;
};

export interface DashboardHeaderOptions {
    content?: string;
}

export function createDashboardHeader(
    parent: blessed.Widgets.Node,
    opts: DashboardHeaderOptions = {},
): blessed.Widgets.BoxElement {
    return blessed.box({
        parent,
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'magenta' }, fg: 'white', bg: 'black' },
        content: opts.content ?? '',
    });
}

export interface DashboardFooterOptions {
    content?: string;
}

export function createDashboardFooter(
    parent: blessed.Widgets.Node,
    opts: DashboardFooterOptions = {},
): blessed.Widgets.BoxElement {
    return blessed.box({
        parent,
        bottom: 0,
        left: 0,
        right: 0,
        height: 3,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'gray' }, fg: 'white', bg: 'black' },
        content: opts.content ?? '',
    });
}

export function setCenteredContent(box: blessed.Widgets.BoxElement, text: string): void {
    const content = `{center}${escTag(text)}{/center}`;
    const target = box as blessed.Widgets.BoxElement & { setContent?: (next: string) => void; content?: string };
    if (typeof target.setContent === 'function') {
        target.setContent(content);

        return;
    }
    target.content = content;
}

export interface DashboardFilterBoxOptions {
    label?: string;
    top?: Dimension;
    left?: Dimension;
    right?: Dimension;
    width?: Dimension;
    height?: number;
    borderColor?: string;
    content?: string;
}

export function createDashboardFilterBox(
    parent: blessed.Widgets.Node,
    opts: DashboardFilterBoxOptions = {},
): blessed.Widgets.BoxElement {
    return blessed.box({
        parent,
        label: ` ${opts.label ?? 'filter'} `,
        top: opts.top ?? 3,
        left: opts.left ?? 0,
        ...(opts.right !== undefined ? { right: opts.right } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : { right: 0 }),
        height: opts.height ?? 3,
        tags: false,
        border: { type: 'line' },
        style: {
            border: { fg: opts.borderColor ?? 'gray' },
            fg: 'white',
            bg: 'black',
        },
        content: opts.content ?? '',
    });
}

export interface DashboardSearchBoxOptions {
    label?: string;
    top?: Dimension;
    left?: Dimension;
    right?: Dimension;
    width?: Dimension;
    height?: number;
    borderColor?: string;
    inputOnFocus?: boolean;
    keys?: boolean;
    mouse?: boolean;
}

export function createDashboardSearchBox(
    parent: blessed.Widgets.Node,
    opts: DashboardSearchBoxOptions = {},
): blessed.Widgets.TextboxElement {
    return blessed.textbox({
        parent,
        label: ` ${opts.label ?? 'search'} `,
        top: opts.top ?? 3,
        left: opts.left ?? 0,
        ...(opts.right !== undefined ? { right: opts.right } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : { right: 0 }),
        height: opts.height ?? 3,
        border: { type: 'line' },
        style: {
            border: { fg: opts.borderColor ?? 'gray' },
            fg: 'white',
            bg: 'black',
        },
        inputOnFocus: opts.inputOnFocus ?? true,
        keys: opts.keys ?? false,
        mouse: opts.mouse ?? true,
    });
}

export interface DashboardListOptions {
    label: string;
    top: Dimension;
    left: Dimension;
    right?: Dimension;
    width?: Dimension;
    bottom?: Dimension;
    height?: Dimension;
    items?: string[];
    borderColor?: string;
    scrollbarColor?: string;
    selectedBg?: string;
    itemColor?: string;
    tags?: boolean;
    keys?: boolean;
    vi?: boolean;
    mouse?: boolean;
}

export function createDashboardList(
    parent: blessed.Widgets.Node,
    opts: DashboardListOptions,
): blessed.Widgets.ListElement {
    return blessed.list({
        parent,
        label: ` ${opts.label} `,
        top: opts.top,
        left: opts.left,
        ...(opts.right !== undefined ? { right: opts.right } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.bottom !== undefined ? { bottom: opts.bottom } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        keys: opts.keys ?? true,
        vi: opts.vi ?? true,
        mouse: opts.mouse ?? true,
        tags: opts.tags ?? false,
        border: { type: 'line' },
        scrollbar: { ch: ' ', style: { bg: opts.scrollbarColor ?? 'magenta' } },
        style: {
            border: { fg: opts.borderColor ?? 'cyan' },
            selected: { bg: opts.selectedBg ?? 'magenta', fg: 'white', bold: true },
            item: { fg: opts.itemColor ?? 'white', bg: 'black' },
            fg: 'white',
            bg: 'black',
        },
        items: opts.items ?? [],
    });
}

export interface DashboardTextPanelOptions {
    label: string;
    top: Dimension;
    left?: Dimension;
    right?: Dimension;
    width?: Dimension;
    bottom?: Dimension;
    height?: Dimension;
    borderColor?: string;
    scrollbarColor?: string;
    content?: string;
    tags?: boolean;
    keys?: boolean;
    vi?: boolean;
    mouse?: boolean;
}

export function createDashboardTextPanel(
    parent: blessed.Widgets.Node,
    opts: DashboardTextPanelOptions,
): blessed.Widgets.BoxElement {
    return blessed.box({
        parent,
        label: ` ${opts.label} `,
        top: opts.top,
        ...(opts.left !== undefined ? { left: opts.left } : {}),
        ...(opts.right !== undefined ? { right: opts.right } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.bottom !== undefined ? { bottom: opts.bottom } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        tags: opts.tags ?? true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: ' ', style: { bg: opts.scrollbarColor ?? 'cyan' } },
        keys: opts.keys ?? true,
        vi: opts.vi ?? true,
        mouse: opts.mouse ?? true,
        border: { type: 'line' },
        style: { border: { fg: opts.borderColor ?? 'gray' }, fg: 'white', bg: 'black' },
        content: opts.content ?? '',
    });
}
export interface VerticalNavigationOptions {
    moveBy: (delta: number) => void;
    top: () => void;
    bottom: () => void;
    submit?: () => void;
    cancel?: () => void;
}

export function attachVerticalNavigation(target: KeyTarget, opts: VerticalNavigationOptions): void {
    target.key(['up', 'k'], () => opts.moveBy(-1));
    target.key(['down', 'j'], () => opts.moveBy(1));
    target.key(['pageup'], () => opts.moveBy(-10));
    target.key(['pagedown'], () => opts.moveBy(10));
    attachJumpKeys(target, opts.moveBy);
    attachTopBottomKeys(target, { top: opts.top, bottom: opts.bottom });
    if (opts.submit) target.key(['enter'], () => opts.submit?.());
    if (opts.cancel) target.key(['q', 'C-c'], () => opts.cancel?.());
}
