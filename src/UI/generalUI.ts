import { SearchOptions } from '@/types/uiTypes';
import blessed from 'blessed';
import figlet from 'figlet';
import { UserCancelled } from '@/UI/menuChain';
import { Key } from 'readline';

/**
 * Shared helpers
 */
function createScreen(title: string): blessed.Widgets.Screen {
    return blessed.screen({ smartCSR: true, title });
}


function uniqueStrings(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of items) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }

    return out;
}

function cleanResolve<T>(
    screen: blessed.Widgets.Screen,
    resolve: (v: T) => void
) {
    let done = false;

    return (value: T) => {
        if (done) return;
        done = true;

        // avoid throwing if already destroyed
        try { screen.destroy(); } catch { /* noop */ }

        resolve(value);
    };
}

function cleanSettle<T>(
    screen: blessed.Widgets.Screen,
    resolve: (v: T) => void,
    reject: (e: unknown) => void
): { finish: (v: T) => void; cancel: () => void } {
    let done = false;

    const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        try { screen.destroy(); } catch { /* noop */ }
        fn();
    };

    return {
        finish: (value: T) => settle(() => resolve(value)),
        cancel: () => settle(() => reject(new UserCancelled())),
    };
}

/**
 * Reusable overlay-style list renderer.
 *
 * Renders each item as its own blessed.box child, ROW_HEIGHT rows tall,
 * with a solid background colour on the selected item (no inline tag tricks).
 * Caller controls items + selection via the returned API; we just paint.
 */
export interface OverlayListOpts {
    parent: blessed.Widgets.Node;
    top: number | string;
    left?: number | string;
    width: number | string;
    height: number | string;
    rowHeight?: number;
    shiftLeftRatio?: number;
    borderColor?: string;
    selectedBg?: string;
}

export interface OverlayList {
    container: blessed.Widgets.BoxElement;
    setItems: (items: string[]) => void;
    getItems: () => string[];
    getSelectedIdx: () => number;
    getSelectedValue: () => string;
    setSelectedIdx: (idx: number) => void;
    move: (direction: 'up' | 'down' | 'pageup' | 'pagedown') => void;
    render: () => void;
}

export function createOverlayList(opts: OverlayListOpts): OverlayList {
    const ROW_HEIGHT = opts.rowHeight ?? 3;
    const shiftRatio = opts.shiftLeftRatio ?? 0.05;
    const borderColor = opts.borderColor ?? 'red';
    const selectedBg = opts.selectedBg ?? 'red';

    const container = blessed.box({
        parent: opts.parent,
        top: opts.top,
        left: opts.left ?? 'center',
        width: opts.width,
        height: opts.height,
        border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: borderColor } },
    });

    let items: string[] = [];
    let selectedIdx = 0;
    let scrollOffset = 0;
    let itemBoxes: blessed.Widgets.BoxElement[] = [];

    const screen = container.screen;

    const render = (): void => {
        itemBoxes.forEach((b) => b.destroy());
        itemBoxes = [];

        const inner = Math.max(1, (container.width as number) - 2);
        const visibleRows = Math.max(ROW_HEIGHT, (container.height as number) - 2);
        const maxVisible = Math.max(1, Math.floor(visibleRows / ROW_HEIGHT));

        if (items.length === 0) {
            const box = blessed.box({
                parent: container,
                top: 0, left: 0, width: inner, height: 1,
                content: '  <no results>',
                style: { fg: 'white', bg: 'black' },
            });
            itemBoxes.push(box);
            screen.render();

            return;
        }

        if (selectedIdx < 0) selectedIdx = 0;
        if (selectedIdx >= items.length) selectedIdx = items.length - 1;

        if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
        if (selectedIdx >= scrollOffset + maxVisible) {
            scrollOffset = selectedIdx - maxVisible + 1;
        }
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, items.length - maxVisible)));

        const maxW = Math.max(1, ...items.map((s) => s.length));
        const centerPad = Math.max(0, Math.floor((inner - maxW) / 2));
        const shift = Math.floor(inner * shiftRatio);
        const leftPad = Math.max(0, centerPad - shift);
        const padStr = ' '.repeat(leftPad);
        const blank = ' '.repeat(inner);

        const end = Math.min(items.length, scrollOffset + maxVisible);
        for (let i = scrollOffset; i < end; i++) {
            const isSel = i === selectedIdx;
            const text = items[i] ?? '';
            const line = (padStr + text).padEnd(inner, ' ');
            const content = ROW_HEIGHT >= 3
                ? [blank, line, blank].join('\n')
                : line;
            const box = blessed.box({
                parent: container,
                top: (i - scrollOffset) * ROW_HEIGHT,
                left: 0,
                width: inner,
                height: ROW_HEIGHT,
                content,
                style: isSel
                    ? { bg: selectedBg, fg: 'white', bold: true }
                    : { bg: 'black', fg: 'white', bold: true },
            });
            itemBoxes.push(box);
        }

        screen.render();
    };

    return {
        container,
        setItems(next) {
            items = next.slice();
            selectedIdx = 0;
            scrollOffset = 0;
        },
        getItems() { return items; },
        getSelectedIdx() { return selectedIdx; },
        getSelectedValue() { return items[selectedIdx] ?? ''; },
        setSelectedIdx(idx) { selectedIdx = idx; },
        move(direction) {
            const count = items.length;
            if (count === 0) return;
            switch (direction) {
                case 'up':
                    selectedIdx = selectedIdx <= 0 ? count - 1 : selectedIdx - 1;
                    break;
                case 'down':
                    selectedIdx = selectedIdx >= count - 1 ? 0 : selectedIdx + 1;
                    break;
                case 'pageup':
                    selectedIdx = Math.max(0, selectedIdx - 5);
                    break;
                case 'pagedown':
                    selectedIdx = Math.min(count - 1, selectedIdx + 5);
                    break;
            }
        },
        render,
    };
}


/**
 * Read-only info screen. Displays `content` in a scrollable, vim-keyed box.
 * Resolves when the user presses Esc/q/Ctrl+C. Used for "nothing here" empty
 * states and detail/body viewers where blessed (with vim navigation) is
 * preferable to spawning nvim.
 */
export async function showInfoScreen(title: string, content: string): Promise<void> {
    return new Promise<void>((resolve) => {
        const screen = createScreen(title);
        const finish = cleanResolve<void>(screen, resolve);

        const headerText = figlet.textSync(title.slice(0, 20), {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default',
        });

        const header = blessed.box({
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: { fg: 'red', bg: 'black' },
        });

        const headerLines = headerText.split('\n').length;

        const body = blessed.box({
            parent: screen,
            top: headerLines + 2,
            left: 'center',
            width: '90%',
            bottom: 3,
            content,
            tags: false,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } },
            scrollable: true,
            alwaysScroll: true,
            keys: true,
            vi: true,
            mouse: true,
            scrollbar: { ch: ' ', style: { bg: 'red' } },
        });

        const status = blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content: 'j/k or ↑/↓: Scroll | g/G: Top/Bottom | Esc/q/Ctrl+C: Back',
            style: { fg: 'white', bg: 'black' },
        });

        screen.append(header);
        screen.append(body);
        screen.append(status);

        screen.key(['escape', 'q'], () => finish());
        screen.key(['C-c'], () => process.exit(0));

        body.focus();
        screen.render();
    });
}

/**
 * Yes / No Prompt
 */
export async function promptUserYesOrNo(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const screen = createScreen('Confirmation');
        const { finish, cancel } = cleanSettle<boolean>(screen, resolve, reject);

        const headerText = figlet.textSync('Confirm', {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        blessed.box({
            parent: screen,
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: { fg: 'red', bg: 'black' }
        });

        const headerLines = headerText.split('\n').length;

        blessed.box({
            parent: screen,
            top: headerLines + 2,
            left: 'center',
            width: '80%',
            height: 5,
            tags: true,
            border: { type: 'line' },
            align: 'center',
            valign: 'middle',
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } },
            content: `{bold}${message}{/bold}\n\nUse ↑/↓ and Enter, or press Y / N.`
        });

        const list = createOverlayList({
            parent: screen,
            top: headerLines + 8,
            shiftLeftRatio: 0,
            width: '40%',
            height: 11,
        });
        list.setItems(['Yes', 'No']);

        blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content: '↑/↓: Navigate | Enter: Select | Y/N: Quick select | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        const keyHandler = blessed.box({
            parent: screen,
            top: 0,
            left: 0,
            width: 0,
            height: 0,
        });

        keyHandler.key(['up', 'down'], (_ch, key) => {
            list.move(key.name as 'up' | 'down');
            list.render();
        });
        keyHandler.key(['enter'], () => {
            finish(list.getSelectedIdx() === 0);
        });

        screen.key(['y', 'Y'], () => finish(true));
        screen.key(['n', 'N'], () => finish(false));
        screen.key(['escape'], () => cancel());
        screen.key(['C-c'], () => process.exit(0));

        keyHandler.focus();
        screen.render();
        list.render();
        screen.on('resize', () => list.render());
    });
}

/**
 * Ask User For Free Text
 */

export async function askUserForInput(message: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const screen = createScreen('Input');
        const { finish, cancel } = cleanSettle<string>(screen, resolve, reject);

        const headerText = figlet.textSync('Input', {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        blessed.box({
            parent: screen,
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: { fg: 'red', bg: 'black' }
        });

        const headerLines = headerText.split('\n').length;

        blessed.box({
            parent: screen,
            top: headerLines + 2,
            left: 'center',
            width: '80%',
            height: 5,
            tags: true,
            border: { type: 'line' },
            align: 'center',
            valign: 'middle',
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } },
            content: `{bold}${message}{/bold}`
        });

        const input = blessed.textbox({
            parent: screen,
            top: headerLines + 8,
            left: 'center',
            width: '50%',
            height: 3,
            inputOnFocus: true,
            border: { type: 'line' },
            style: {
                fg: 'white',
                bg: 'black',
                bold: true,
                border: { fg: 'red' },
                focus: { bg: 'red' }
            }
        });

        blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content: 'Enter: Submit | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        input.key(['enter'], () => {
            finish(input.getValue());
        });

        screen.key(['escape'], () => cancel());
        screen.key(['C-c'], () => process.exit(0));

        input.focus();
        screen.render();
    });
}

/**
 * Search + Select (with type vs selection confirm)
 */
export async function searchAndSelect(options: SearchOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const screen = createScreen('Search and Select');
        const { finish, cancel } = cleanSettle<string>(screen, resolve, reject);

        let items = uniqueStrings(options.itemsArray);
        if (!items.length) items = ['<no items>'];

        const headerText = figlet.textSync(options.prompt, {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        const question = blessed.box({
            parent: screen,
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: { fg: 'red', bg: 'black' }
        });

        const headerLines = headerText.split('\n').length;

        const searchBox = blessed.textbox({
            parent: screen,
            top: headerLines + 1,
            left: 'center',
            width: '80%',
            height: 3,
            inputOnFocus: false,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } }
        });

        const list = createOverlayList({
            parent: screen,
            top: headerLines + 4,
            width: '80%',
            height: '60%',
        });
        list.setItems(items);

        blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content:
                '↑/↓: Navigate | Enter: Select | Type to filter | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        // 'question' is appended via parent: screen above
        void question;

        const applyFilter = (raw: string): void => {
            const term = raw.toLowerCase();
            const filtered =
                term.trim().length === 0
                    ? items
                    : items.filter((s) => s.toLowerCase().includes(term));
            list.setItems(filtered);
            list.render();
        };

        searchBox.on('keypress', (ch, key: Key) => {
            if (key.name === 'enter') return;

            if (key.name === 'backspace') {
                const val = searchBox.getValue().slice(0, -1);
                searchBox.setValue(val);
                applyFilter(val);
                screen.render();

                return;
            }

            if (ch && !key.ctrl && !key.meta) {
                const val = searchBox.getValue() + ch;
                searchBox.setValue(val);
                applyFilter(val);
                screen.render();
            }
        });


        searchBox.key(['up', 'down', 'pageup', 'pagedown'], (_ch, key) => {
            list.move(key.name as 'up' | 'down' | 'pageup' | 'pagedown');
            list.render();
        });

        searchBox.key(['enter'], async (): Promise<void> => {
            const typedValue = searchBox.getValue();
            const selectedValue = list.getSelectedValue();

            if (
                typedValue &&
                selectedValue &&
                selectedValue !== '<no results>' &&
                selectedValue !== '<no items>'
            ) {
                const useTyped = await promptUserYesOrNo(
                    `Use typed value "${typedValue}" instead of selected "${selectedValue}"?`
                );
                finish(useTyped ? typedValue : selectedValue);
            } else if (typedValue) {
                finish(typedValue);
            } else if (selectedValue && selectedValue !== '<no results>' && selectedValue !== '<no items>') {
                finish(selectedValue);
            } else {
                finish('');
            }
        });

        screen.key(['escape'], () => cancel());
        screen.key(['C-c'], () => process.exit(0));

        searchBox.focus();
        screen.render();
        list.render();
        screen.on('resize', () => list.render());
    });
}

/**
 * Search + Select (simple: always return list selection)
 */
export async function searchSelectAndReturnFromArray(
    options: SearchOptions
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const screen = createScreen('Search and Select');
        const { finish, cancel } = cleanSettle<string>(screen, resolve, reject);

        let items = uniqueStrings(options.itemsArray);
        if (!items.length) items = ['<no items>'];

        const headerText = figlet.textSync(options.prompt, {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        blessed.box({
            parent: screen,
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: { fg: 'red', bg: 'black' }
        });

        const headerLines = headerText.split('\n').length;

        const searchBox = blessed.textbox({
            parent: screen,
            top: headerLines + 1,
            left: 'center',
            width: '80%',
            height: 3,
            inputOnFocus: false,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } }
        });

        const list = createOverlayList({
            parent: screen,
            top: headerLines + 4,
            width: '80%',
            height: '60%',
        });
        list.setItems(items);

        blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content:
                '↑/↓: Navigate | Enter: Select | Type to filter | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        const applyFilter = (raw: string): void => {
            const term = raw.toLowerCase();
            const filtered =
                term.trim().length === 0
                    ? items
                    : items.filter((s) => s.toLowerCase().includes(term));
            list.setItems(filtered);
            list.render();
        };


        searchBox.on('keypress', (ch, key: Key) => {
            if (key.name === 'enter') return;

            if (key.name === 'backspace') {
                const val = searchBox.getValue().slice(0, -1);
                searchBox.setValue(val);
                applyFilter(val);
                screen.render();

                return;
            }

            if (ch && !key.ctrl && !key.meta) {
                const val = searchBox.getValue() + ch;
                searchBox.setValue(val);
                applyFilter(val);
                screen.render();
            }
        });

        searchBox.key(['up', 'down', 'pageup', 'pagedown'], (_ch, key) => {
            list.move(key.name as 'up' | 'down' | 'pageup' | 'pagedown');
            list.render();
        });

        searchBox.key(['enter'], () => {
            finish(list.getSelectedValue());
        });

        screen.key(['escape'], () => cancel());
        screen.key(['C-c'], () => process.exit(0));

        searchBox.focus();
        screen.render();
        list.render();
        screen.on('resize', () => list.render());
    });
}
