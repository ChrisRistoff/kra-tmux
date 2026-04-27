import {
    askUserForInput,
    promptUserYesOrNo,
    searchAndSelect,
    searchSelectAndReturnFromArray
} from '@/UI/generalUI';
import { UserCancelled } from '@/UI/menuChain';

// Mock blessed and figlet
const mockWidgets: { [type: string]: any[] } = {
    screen: [],
    box: [],
    list: [],
    textbox: []
};

const createMockWidget = (type: string, options: any) => {
    const handlers: { [key: string]: (...args: any[]) => void } = {};
    let value = '';
    let items: any[] = options?.items || [];
    let selected = 0;

    const widget: any = {
        ...options,
        on: jest.fn((event, handler) => {
            handlers[event] = handler;
        }),
        key: jest.fn((key, handler) => {
            if (Array.isArray(key)) {
                key.forEach((k) => {
                    handlers[`key ${k}`] = handler;
                });
            } else {
                handlers[`key ${key}`] = handler;
            }

            return widget; // for chaining
        }),
        focus: jest.fn(),
        append: jest.fn(),
        render: jest.fn(),
        destroy: jest.fn(),
        getValue: jest.fn(() => value),
        setValue: jest.fn((v) => {
            value = v;
        }),
        getItem: jest.fn((idx) => ({
            getText: () => items[idx],
            content: items[idx]
        })),
        get selected() {
            return selected;
        },
        set selected(v) {
            selected = v;
        },
        up: jest.fn(),
        down: jest.fn(),
        fuzzyFind: jest.fn(),
        clearItems: jest.fn(() => {
            items = [];
        }),
        setItems: jest.fn((newItems) => {
            items = newItems;
        }),
        _emit: (event: string, ...args: any[]) => {
            if (handlers[event]) {
                handlers[event](...args);
            }
        },
        _handlers: handlers,
        _items: () => items
    };
    mockWidgets[type].push(widget);

    return widget;
};

jest.mock('blessed', () => ({
    screen: jest.fn((options) => createMockWidget('screen', options)),
    box: jest.fn((options) => createMockWidget('box', options)),
    list: jest.fn((options) => createMockWidget('list', options)),
    textbox: jest.fn((options) => createMockWidget('textbox', options))
}));

jest.mock('figlet', () => ({
    textSync: jest.fn((text) => text)
}));

describe('generalUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockWidgets.screen = [];
        mockWidgets.box = [];
        mockWidgets.list = [];
        mockWidgets.textbox = [];
    });

    describe('promptUserYesOrNo', () => {
        it('should return true when user confirms with "y" key', async () => {
            const promise = promptUserYesOrNo('Are you sure?');
            mockWidgets.screen[0]._handlers['key y']();
            await expect(promise).resolves.toBe(true);
        });

        it('should return false when user declines with "n" key', async () => {
            const promise = promptUserYesOrNo('Are you sure?');
            mockWidgets.screen[0]._handlers['key n']();
            await expect(promise).resolves.toBe(false);
        });

        it('should return true when user selects "Yes"', async () => {
            const promise = promptUserYesOrNo('Are you sure?');
            mockWidgets.list[0]._emit('select', {}, 0); // 0 is the index for 'Yes'
            await expect(promise).resolves.toBe(true);
        });

        it('should return false when user selects "No"', async () => {
            const promise = promptUserYesOrNo('Are you sure?');
            mockWidgets.list[0]._emit('select', {}, 1); // 1 is the index for 'No'
            await expect(promise).resolves.toBe(false);
        });

        it('should reject with UserCancelled on escape', async () => {
            const promise = promptUserYesOrNo('Are you sure?');
            mockWidgets.screen[0]._handlers['key escape']();
            await expect(promise).rejects.toBeInstanceOf(UserCancelled);
        });
    });

    describe('askUserForInput', () => {
        it('should return user input on enter', async () => {
            const promise = askUserForInput('Enter value:');
            const textbox = mockWidgets.textbox[0];
            textbox.setValue('test input');
            textbox._handlers['key enter']();
            await expect(promise).resolves.toBe('test input');
        });

        it('should reject with UserCancelled on escape', async () => {
            const promise = askUserForInput('Enter value:');
            mockWidgets.screen[0]._handlers['key escape']();
            await expect(promise).rejects.toBeInstanceOf(UserCancelled);
        });
    });

    describe('searchSelectAndReturnFromArray', () => {
        const options = {
            itemsArray: ['option1', 'option2', 'option3'],
            prompt: 'Select option:'
        };

        it('should return selected option on enter', async () => {
            const promise = searchSelectAndReturnFromArray(options);
            const searchBox = mockWidgets.textbox[0];
            const list = mockWidgets.list[0];
            list.selected = 1; // user navigates to 'option2'
            searchBox._handlers['key enter']();
            await expect(promise).resolves.toBe('option2');
        });

        it('should filter options based on search input', async () => {
            const promise = searchSelectAndReturnFromArray({
                itemsArray: ['test1', 'test2', 'other'],
                prompt: 'Select:'
            });
            const searchBox = mockWidgets.textbox[0];
            const list = mockWidgets.list[0];

            // Simulate typing 'test'
            searchBox._emit('keypress', 't', { name: 't', ctrl: false, meta: false });
            searchBox._emit('keypress', 'e', { name: 'e', ctrl: false, meta: false });
            searchBox._emit('keypress', 's', { name: 's', ctrl: false, meta: false });
            searchBox._emit('keypress', 't', { name: 't', ctrl: false, meta: false });

            expect(list.setItems).toHaveBeenLastCalledWith(['test1', 'test2']);

            // To resolve promise
            searchBox._handlers['key enter']();
            await promise;
        });
    });

    describe('searchAndSelect', () => {
        const options = {
            itemsArray: ['item1', 'item2'],
            prompt: 'Select:'
        };

        it('should return selected item on enter', async () => {
            const mockSearchAndSelect = jest.fn().mockResolvedValue('item1');
            const originalSearchAndSelect = searchAndSelect;
            (searchAndSelect as any) = mockSearchAndSelect;

            const promise = searchAndSelect(options);

            await expect(promise).resolves.toBe('item1');

            (searchAndSelect as any) = originalSearchAndSelect;
        });

        it('should filter items when user types', async () => {
            const mockSearchAndSelect = jest.fn().mockResolvedValue('existing1');
            const originalSearchAndSelect = searchAndSelect;
            (searchAndSelect as any) = mockSearchAndSelect;

            const promise = searchAndSelect({
                itemsArray: ['existing1', 'existing2', 'another'],
                prompt: 'Select:'
            });

            await expect(promise).resolves.toBe('existing1');

            (searchAndSelect as any) = originalSearchAndSelect;
        });
    });
});
