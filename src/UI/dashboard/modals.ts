import * as blessed from 'blessed';
import { escTag } from './escTag';

export interface OverlayResult<T> { value: T | null }

export interface ModalTextOptions {
    multiline?: boolean;
    /** Hint shown at the bottom of the box. Defaults to "enter save · esc cancel". */
    hint?: string;
}

export async function modalText(
    screen: blessed.Widgets.Screen,
    label: string,
    initial: string,
    opts: ModalTextOptions = {},
): Promise<OverlayResult<string>> {
    return new Promise((resolve) => {
        const multiline = opts.multiline === true;
        const hint = opts.hint ?? 'enter save · esc cancel';
        const height = multiline ? 12 : 5;
        const box = blessed.box({
            parent: screen,
            label: ` ${label} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height,
            border: { type: 'line' },
            style: { border: { fg: 'magenta' }, bg: 'black' },
            tags: true,
        });
        const input = blessed.textbox({
            parent: box,
            top: 1,
            left: 1,
            right: 1,
            height: multiline ? height - 4 : 1,
            inputOnFocus: true,
            keys: true,
            mouse: true,
            style: { bg: 'black', fg: 'white' },
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
            screen.render();
            resolve({ value: val });
        };
        input.key(['escape'], () => cleanup(null));
        input.key(['enter'], () => cleanup(input.getValue()));
        input.on('submit', () => cleanup(input.getValue()));
        input.on('cancel', () => cleanup(null));
        input.focus();
        input.readInput();
        screen.render();
    });
}

export async function modalChoice(
    screen: blessed.Widgets.Screen,
    label: string,
    choices: string[],
    selected?: string,
): Promise<OverlayResult<string>> {
    return new Promise((resolve) => {
        const list = blessed.list({
            parent: screen,
            label: ` ${label} `,
            top: 'center',
            left: 'center',
            width: '50%',
            height: Math.min(choices.length + 2, 20),
            border: { type: 'line' },
            keys: true,
            vi: true,
            mouse: true,
            tags: false,
            scrollbar: { ch: ' ', style: { bg: 'magenta' } },
            style: {
                border: { fg: 'magenta' },
                selected: { bg: 'magenta', fg: 'white', bold: true },
                item: { fg: 'white' },
                bg: 'black',
            },
            items: choices,
        });
        if (selected) {
            const idx = choices.indexOf(selected);
            if (idx >= 0) list.select(idx);
        }
        const cleanup = (val: string | null): void => {
            list.destroy();
            screen.render();
            resolve({ value: val });
        };
        list.key(['escape', 'q'], () => cleanup(null));
        list.on('select', (_i, idx) => cleanup(choices[idx] ?? null));
        list.focus();
        screen.render();
    });
}

export async function modalConfirm(
    screen: blessed.Widgets.Screen,
    label: string,
    prompt: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let selected: 'yes' | 'no' = 'no';
        const box = blessed.box({
            parent: screen,
            label: ` ${label} `,
            top: 'center',
            left: 'center',
            width: '60%',
            height: 11,
            border: { type: 'line' },
            tags: true,
            style: { border: { fg: 'red' }, bg: 'black' },
        });
        blessed.box({
            parent: box,
            top: 1, left: 2, right: 2, height: 3,
            tags: true,
            style: { bg: 'black' },
            content: escTag(prompt),
        });
        const yesBtn = blessed.box({
            parent: box,
            top: 5, left: '25%-7', width: 14, height: 3,
            tags: true,
            border: { type: 'line' },
            content: '{center}{bold}Yes{/bold}{/center}',
            style: { border: { fg: 'green' }, fg: 'green', bg: 'black' },
        });
        const noBtn = blessed.box({
            parent: box,
            top: 5, left: '75%-7', width: 14, height: 3,
            tags: true,
            border: { type: 'line' },
            content: '{center}{bold}No{/bold}{/center}',
            style: { border: { fg: 'red' }, fg: 'red', bg: 'black' },
        });
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
        const finish = (val: boolean): void => { box.destroy(); screen.render(); resolve(val); };
        box.key(['y', 'Y'], () => finish(true));
        box.key(['n', 'N', 'escape'], () => finish(false));
        box.key(['left', 'right', 'h', 'l', 'tab'], () => {
            selected = selected === 'yes' ? 'no' : 'yes';
            paint();
        });
        box.key(['enter', 'space'], () => finish(selected === 'yes'));
        box.focus();
        paint();
    });
}
