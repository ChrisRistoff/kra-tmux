import { SearchOptions } from '@/types/uiTypes';
import blessed from 'blessed';
import figlet from 'figlet';

/**
 * Shared helpers
 */
function createScreen(title: string) {
    return blessed.screen({ smartCSR: true, title });
}

function getListSelectedValue(list: blessed.Widgets.ListElement): string {
    const idx = (list as any).selected ?? 0;
    const item = list.getItem(idx);

    return (item.getText()) || (item.content ?? '');
}

function uniqueStrings(items: string[]) {
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

/**
 * Yes / No Prompt
 */
export async function promptUserYesOrNo(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const screen = createScreen('Confirmation');
        const finish = cleanResolve<boolean>(screen, resolve);

        const headerText = figlet.textSync('Confirm', {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        const question = blessed.box({
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: {
                fg: 'red',
                bg: 'black'
            }
        });

        const headerLines = headerText.split('\n').length;

        const box = blessed.box({
            parent: screen,
            top: headerLines + 2,
            left: 'center',
            width: '60%',
            height: '50%',
            tags: true,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } },
            content: `${message}\n\nUse ↑/↓ and Enter, or press Y / N.`
        });

        const list = blessed.list({
            parent: box,
            top: 5,
            left: 'center',
            width: '50%',
            height: 4,
            items: ['Yes', 'No'],
            keys: true,
            vi: true,
            mouse: true,
            style: {
                fg: 'white',
                bg: 'black',
                border: { fg: 'red' },
                selected: { bg: 'red' }
            },
            border: { type: 'line' }
        });

        const status = blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content: '↑/↓: Navigate | Enter: Select | Y/N: Quick select | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        screen.append(question);
        screen.append(box);
        screen.append(status);

        list.on('select', (_item, index) => {
            finish(index === 0);
        });

        // Global quick keys + quit
        screen.key(['y', 'Y'], () => finish(true));
        screen.key(['n', 'N'], () => finish(false));
        screen.key(['escape', 'C-c'], () => finish(false));

        list.focus();
        screen.render();
    });
}

/**
 * Ask User For Free Text
 */

export async function askUserForInput(message: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const screen = createScreen('Input');
        const finish = cleanResolve<string>(screen, resolve);

        const headerText = figlet.textSync('Input', {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        const question = blessed.box({
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: {
                fg: 'red',
                bg: 'black'
            }
        });

        const headerLines = headerText.split('\n').length;

        const box = blessed.box({
            parent: screen,
            top: headerLines + 2,
            left: 'center',
            width: '70%',
            height: '50%',
            tags: true,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } },
            content: message
        });

        const input = blessed.textbox({
            parent: box,
            top: '70%',
            left: 'center',
            width: '80%',
            height: 3,
            inputOnFocus: true,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' }, focus: { bg: 'red' } }
        });

        const status = blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content: 'Enter: Submit | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        screen.append(question);
        screen.append(box);
        screen.append(status);

        // Handle Enter from the textbox only; let screen handle Esc/Ctrl+C
        input.key(['enter'], () => {
            const value = input.getValue();
            finish(value);
        });

        // Global quit keys
        screen.key(['escape', 'C-c'], () => finish(''));

        input.focus();
        screen.render();
    });
}

/**
 * Search + Select (with type vs selection confirm)
 */
export async function searchAndSelect(options: SearchOptions): Promise<string> {
    return new Promise<string>((resolve) => {
        const screen = createScreen('Search and Select');
        const finish = cleanResolve<string>(screen, resolve);

        let items = uniqueStrings(options.itemsArray || []);
        if (!items.length) items = ['<no items>'];

        const headerText = figlet.textSync(options.prompt, {
            font: 'Banner',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        const question = blessed.box({
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: {
                fg: 'red',
                bg: 'black'
            }
        });

        const headerLines = headerText.split('\n').length;

        const searchBox = blessed.textbox({
            parent: screen,
            top: headerLines + 1,
            left: 'center',
            width: '60%',
            height: 3,
            inputOnFocus: false,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } }
        });

        const listBox = blessed.list({
            parent: screen,
            top: headerLines + 4,
            left: 'center',
            width: '60%',
            height: '60%',
            items,
            keys: true,
            vi: true,
            mouse: true,
            border: { type: 'line' },
            style: {
                fg: 'white',
                bg: 'black',
                border: { fg: 'red' },
                selected: { bg: 'red' }
            }
        });

        const status = blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content:
                '↑/↓: Navigate | Enter: Select | Type to filter | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        screen.append(question);
        screen.append(searchBox);
        screen.append(listBox);
        screen.append(status);

        const applyFilter = (raw: string) => {
            const term = raw.toLowerCase();
            const filtered =
                term.trim().length === 0
                    ? items
                    : items.filter((s) => s.toLowerCase().includes(term));

            listBox.clearItems();
            listBox.setItems(filtered.length ? filtered : ['<no results>']);
            listBox.fuzzyFind(raw);
            screen.render();
        };

        searchBox.on('keypress', (ch, key) => {
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
            switch (key.name) {
                case 'up':
                    listBox.up(1);
                    break;
                case 'down':
                    listBox.down(1);
                    break;
                case 'pageup':
                    listBox.up((listBox.height as number) - 1);
                    break;
                case 'pagedown':
                    listBox.down((listBox.height as number) - 1);
                    break;
            }

            screen.render();
        });

        searchBox.key(['enter'], async () => {
            const typedValue = searchBox.getValue();
            const selectedValue = getListSelectedValue(listBox);

            if (
                typedValue &&
                selectedValue &&
                selectedValue !== '<no results>'
            ) {
                const useTyped = await promptUserYesOrNo(
                    `Use typed value "${typedValue}" instead of selected "${selectedValue}"?`
                );

                if (useTyped) {
                    finish(typedValue);
                } else {
                    finish(selectedValue);
                }
            } else if (typedValue) {
                finish(typedValue);
            } else if (
                selectedValue !== '<no results>'
            ) {
                finish(selectedValue);
            } else {
                finish('');
            }
        });

        screen.key(['escape', 'C-c'], () => finish(''));

        searchBox.focus();
        screen.render();
    });
}

/**
 * Search + Select (simple: always return list selection)
 */
export async function searchSelectAndReturnFromArray(
    options: SearchOptions
): Promise<string> {
    return new Promise<string>((resolve) => {
        const screen = createScreen('Search and Select');
        const finish = cleanResolve<string>(screen, resolve);

        let items = uniqueStrings(options.itemsArray || []);
        if (!items.length) items = ['<no items>'];

        const headerText = figlet.textSync(options.prompt, {
            font: 'Banner', // try: 'Big', 'Standard', 'Banner', 'Block', etc.
            horizontalLayout: 'default',
            verticalLayout: 'default'
        });

        const question = blessed.box({
            top: 0,
            left: 'center',
            width: '100%',
            height: 7,          // taller box for big text
            content: '{bold}' + headerText + '{/bold}',
            tags: true,
            align: 'center',
            valign: 'middle',
            style: {
                fg: 'red',
                bg: 'black'
            }
        });

        const headerLines = headerText.split('\n').length;

        const searchBox = blessed.textbox({
            parent: screen,
            top: headerLines + 1,  // place just below the header
            left: 'center',
            width: '60%',
            height: 3,
            inputOnFocus: false,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' } }
        });

        const listBox = blessed.list({
            parent: screen,
            top: headerLines + 4, // below search box
            left: 'center',
            width: '60%',
            height: '60%',
            items,
            keys: true,
            vi: true,
            mouse: true,
            border: { type: 'line' },
            style: { fg: 'white', bg: 'black', border: { fg: 'red' }, selected: { bg: 'red' } }
        });


        const status = blessed.box({
            parent: screen,
            bottom: 0,
            left: 'center',
            width: '100%',
            height: 3,
            content:
                '↑/↓: Navigate | Enter: Select | Type to filter | Esc/Ctrl+C: Cancel',
            style: { fg: 'white', bg: 'black' }
        });

        screen.append(question);
        screen.append(searchBox);
        screen.append(listBox);
        screen.append(status);

        const applyFilter = (raw: string) => {
            const term = raw.toLowerCase();
            const filtered =
                term.trim().length === 0
                    ? items
                    : items.filter((s) => s.toLowerCase().includes(term));

            listBox.clearItems();
            listBox.setItems(filtered.length ? filtered : ['<no results>']);
            listBox.fuzzyFind(raw);
            screen.render();
        };

        searchBox.on('keypress', (ch, key) => {
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
            switch (key.name) {
                case 'up':
                    listBox.up(1);
                    break;
                case 'down':
                    listBox.down(1);
                    break;
                case 'pageup':
                    listBox.up((listBox.height as number) - 1);
                    break;
                case 'pagedown':
                    listBox.down((listBox.height as number) - 1);
                    break;
            }

            screen.render();
        });

        searchBox.key(['enter'], () => {
            const value = getListSelectedValue(listBox);
            finish(value === '<no results>' ? '' : value);
        });

        screen.key(['escape', 'C-c'], () => {
            try { screen.destroy(); } catch (e) { /* noop */ }
            process.exit(0);
        });

        searchBox.focus();
        screen.render();
    });
}
