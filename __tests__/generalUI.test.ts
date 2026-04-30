import {
    askUserForInput,
    promptUserYesOrNo,
    searchAndSelect,
    searchSelectAndReturnFromArray,
} from '@/UI/generalUI';
import { UserCancelled } from '@/UI/menuChain';

const mockConfirmDashboard = jest.fn();
const mockInputDashboard = jest.fn();
const mockPickList = jest.fn();

jest.mock('blessed', () => ({
    screen: jest.fn(),
    box: jest.fn(),
    list: jest.fn(),
    textbox: jest.fn(),
}));

jest.mock('figlet', () => ({
    textSync: jest.fn((text) => text),
}));

jest.mock('@/UI/dashboard/pickList', () => ({
    confirmDashboard: (...args: unknown[]) => mockConfirmDashboard(...args),
    inputDashboard: (...args: unknown[]) => mockInputDashboard(...args),
    pickList: (...args: unknown[]) => mockPickList(...args),
}));

describe('generalUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('promptUserYesOrNo', () => {
        it('delegates to confirmDashboard', async () => {
            mockConfirmDashboard.mockResolvedValue(true);

            await expect(promptUserYesOrNo('Are you sure?')).resolves.toBe(true);
            expect(mockConfirmDashboard).toHaveBeenCalledWith({
                title: 'Confirm',
                prompt: 'Are you sure?',
            });
        });

        it('returns false when the dashboard resolves false', async () => {
            mockConfirmDashboard.mockResolvedValue(false);

            await expect(promptUserYesOrNo('Nope?')).resolves.toBe(false);
        });
    });

    describe('askUserForInput', () => {
        it('delegates to inputDashboard and returns the entered value', async () => {
            mockInputDashboard.mockResolvedValue('test input');

            await expect(askUserForInput('Enter value:')).resolves.toBe('test input');
            expect(mockInputDashboard).toHaveBeenCalledWith({
                title: 'Input',
                prompt: 'Enter value:',
            });
        });

        it('rejects with UserCancelled when the dashboard returns null', async () => {
            mockInputDashboard.mockResolvedValue(null);

            await expect(askUserForInput('Enter value:')).rejects.toBeInstanceOf(UserCancelled);
        });
    });
    describe('searchAndSelect', () => {
        it('uses pickList as the shared UI source', async () => {
            mockPickList.mockResolvedValue({ value: 'option2' });

            await expect(searchAndSelect({
                itemsArray: ['option1', 'option2', 'option2'],
                prompt: 'Select option:',
            })).resolves.toBe('option2');

            expect(mockPickList).toHaveBeenCalledWith(expect.objectContaining({
                title: 'Select option:',
                header: 'Select option:',
                items: ['option1', 'option2'],
                submitSearchQuery: true,
            }));
        });

        it('can return the typed search query after confirmation', async () => {
            mockPickList.mockResolvedValue({ value: 'option1', action: 'search-submit', query: 'typed' });
            mockConfirmDashboard.mockResolvedValue(true);

            await expect(searchAndSelect({
                itemsArray: ['option1', 'option2'],
                prompt: 'Select option:',
            })).resolves.toBe('typed');

            expect(mockConfirmDashboard).toHaveBeenCalledWith({
                title: 'Confirm',
                prompt: 'Use typed value "typed" instead of selected "option1"?',
            });
        });
    });

    describe('searchSelectAndReturnFromArray', () => {
        it('maps required options to pickList and returns the selected value', async () => {
            mockPickList.mockResolvedValue({ value: 'option2' });

            await expect(searchSelectAndReturnFromArray({
                itemsArray: ['option1', 'option2', 'option3'],
                prompt: 'Select option:',
            })).resolves.toBe('option2');

            const pickerArgs = mockPickList.mock.calls[0]?.[0];
            expect(pickerArgs).toEqual(expect.objectContaining({
                title: 'Select option:',
                header: 'Select option:',
                items: ['option1', 'option2', 'option3'],
                detailsUseTags: true,
                details: expect.any(Function),
            }));
            expect(pickerArgs.details('option2', 1)).toContain('{cyan-fg}selected{/cyan-fg}');
        });
        it('forwards optional picker settings', async () => {
            const details = jest.fn(async () => 'details');
            mockPickList.mockResolvedValue({ value: 'option1' });

            await expect(searchSelectAndReturnFromArray({
                itemsArray: ['option1', 'option2'],
                prompt: 'Select option:',
                header: 'Custom header',
                details,
                selected: 'option2',
                showDetailsPanel: false,
                pageSize: 25,
            })).resolves.toBe('option1');

            expect(mockPickList).toHaveBeenCalledWith({
                title: 'Select option:',
                header: 'Custom header',
                items: ['option1', 'option2'],
                details,
                selected: 'option2',
                showDetailsPanel: false,
                pageSize: 25,
            });
        });
        it('rejects with UserCancelled when the picker is cancelled', async () => {
            mockPickList.mockResolvedValue({ value: null });

            await expect(searchSelectAndReturnFromArray({
                itemsArray: ['option1'],
                prompt: 'Select option:',
            })).rejects.toBeInstanceOf(UserCancelled);
        });
    });
});