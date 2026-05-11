/**
 * Read-only / multi-select / confirm modals for the TUI chat: file
 * contexts popup (f), remove-context picker (r), and a generic confirm.
 */

import * as blessed from 'blessed';
import { pauseScreenKeys } from '@/UI/dashboard';
import { BG_PRIMARY } from '../theme';

export async function showContextsPopupModal(
    screen: blessed.Widgets.Screen,
    title: string,
    lines: string[],
): Promise<void> {
    return new Promise((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape']);
        const savedFocus = screen.focused;
        const box = blessed.box({
            parent: screen,
            label: ` ${title} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height: '70%',
            border: { type: 'line' },
            style: { border: { fg: 'cyan' }, bg: BG_PRIMARY },
            // tags off so blessed leaves raw ANSI escapes (cli-highlight
            // emits \x1b[...m sequences) intact for the terminal to
            // render as syntax-highlighted code snippets.
            tags: false,
            scrollable: true,
            alwaysScroll: true,
            keys: true,
            vi: true,
            mouse: true,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            content: lines.join('\n'),
        });
        const cleanup = (): void => {
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve();
        };
        box.key(['escape', 'q', 'enter', 'C-c'], cleanup);
        box.focus();
        screen.render();
    });
}

export async function multiSelectModal(
    screen: blessed.Widgets.Screen,
    title: string,
    items: string[],
): Promise<number[] | null> {
    if (items.length === 0) return null;

    return new Promise((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape', 'space', 'enter']);
        const savedFocus = screen.focused;
        const selected = new Set<number>();

        const renderItems = (): string[] => items.map(
            (it, i) => `${selected.has(i) ? '[x]' : '[ ]'} ${it}`,
        );

        const list = blessed.list({
            parent: screen,
            label: ` ${title} `,
            top: 'center',
            left: 'center',
            width: '80%',
            height: '70%',
            border: { type: 'line' },
            keys: true,
            vi: true,
            mouse: true,
            scrollbar: { ch: ' ', style: { bg: 'magenta' } },
            style: {
                border: { fg: 'magenta' },
                selected: { bg: 'magenta', fg: 'white', bold: true },
                item: { fg: 'white' },
                bg: BG_PRIMARY,
            },
            items: renderItems(),
        });
        blessed.box({
            parent: list,
            bottom: 0,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            content: '{gray-fg}space toggle · enter confirm · esc cancel{/gray-fg}',
        });
        const cleanup = (val: number[] | null): void => {
            list.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(val);
        };
        list.key(['space'], () => {
            const idx = (list as unknown as { selected: number }).selected;
            if (selected.has(idx)) selected.delete(idx);
            else selected.add(idx);
            list.setItems(renderItems());
            list.select(idx);
            screen.render();
        });
        list.key(['enter'], () => {
            if (selected.size === 0) {
                const idx = (list as unknown as { selected: number }).selected;
                cleanup([idx]);

                return;
            }
            cleanup([...selected].sort((a, b) => a - b));
        });
        list.key(['escape', 'q', 'C-c'], () => cleanup(null));
        list.focus();
        screen.render();
    });
}

export async function confirmModal(
    screen: blessed.Widgets.Screen,
    title: string,
    body: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape']);
        const savedFocus = screen.focused;
        const box = blessed.box({
            parent: screen,
            label: ` ${title} `,
            top: 'center',
            left: 'center',
            width: '60%',
            height: 8,
            border: { type: 'line' },
            style: { border: { fg: 'red' }, bg: BG_PRIMARY },
            tags: true,
            content: `${body}\n\n{gray-fg}y = yes · n / esc = no{/gray-fg}`,
        });
        const cleanup = (val: boolean): void => {
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(val);
        };
        box.key(['y', 'Y'], () => cleanup(true));
        box.key(['n', 'N', 'escape', 'q', 'C-c'], () => cleanup(false));
        box.focus();
        screen.render();
    });
}

export async function inputModal(
    screen: blessed.Widgets.Screen,
    title: string,
    initial = '',
    hint = 'enter submit · esc cancel',
): Promise<string | null> {
    return new Promise((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape']);
        const savedFocus = screen.focused;
        const box = blessed.box({
            parent: screen,
            label: ` ${title} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height: 6,
            border: { type: 'line' },
            style: { border: { fg: 'magenta' }, bg: BG_PRIMARY },
            tags: true,
        });
        const input = blessed.textbox({
            parent: box,
            top: 1,
            left: 1,
            right: 1,
            height: 1,
            inputOnFocus: true,
            keys: true,
            mouse: true,
            style: { bg: BG_PRIMARY, fg: 'white' },
        });
        blessed.box({
            parent: box,
            bottom: 0,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            content: `{gray-fg}${hint}{/gray-fg}`,
        });
        input.setValue(initial);
        const cleanup = (val: string | null): void => {
            box.destroy();
            restoreKeys();
            if (savedFocus) {
                try { savedFocus.focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve(val);
        };
        input.key(['escape'], () => cleanup(null));
        input.key(['enter'], () => cleanup(input.getValue()));
        input.focus();
        input.readInput();
        screen.render();
    });
}
