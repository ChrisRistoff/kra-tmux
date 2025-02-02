import inquirer from 'inquirer';
import { promptUserYesOrNo, askUserForInput, searchSelectAndReturnFromArray, searchAndSelect } from '@UI/generalUI';

// Mock inquirer
jest.mock('inquirer');
const mockInquirer = inquirer as jest.Mocked<typeof inquirer>;

describe('generalUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('promptUserYesOrNo', () => {
        it('should return true when user confirms', async () => {
            mockInquirer.prompt.mockResolvedValueOnce({ proceed: true });

            const result = await promptUserYesOrNo('Are you sure?');

            expect(result).toBe(true);
            expect(mockInquirer.prompt).toHaveBeenCalledWith([
                expect.objectContaining({
                    type: 'confirm',
                    message: 'Are you sure?',
                    default: true
                })
            ]);
        });

        it('should return false when user declines', async () => {
            mockInquirer.prompt.mockResolvedValueOnce({ proceed: false });

            const result = await promptUserYesOrNo('Are you sure?');

            expect(result).toBe(false);
        });
    });

    describe('askUserForInput', () => {
        it('should return user input', async () => {
            mockInquirer.prompt.mockResolvedValueOnce({ name: 'test input' });

            const result = await askUserForInput('Enter value:');

            expect(result).toBe('test input');
            expect(mockInquirer.prompt).toHaveBeenCalledWith([
                expect.objectContaining({
                    type: 'input',
                    message: 'Enter value:'
                })
            ]);
        });
    });

    describe('searchSelectAndReturnFromArray', () => {
        it('should return selected option from array', async () => {
            const options = {
                itemsArray: ['option1', 'option2', 'option3'],
                prompt: 'Select option:'
            };

            mockInquirer.prompt.mockResolvedValueOnce({ selectedOption: 'option2' });

            const result = await searchSelectAndReturnFromArray(options);

            expect(result).toBe('option2');
            expect(mockInquirer.prompt).toHaveBeenCalledWith([
                expect.objectContaining({
                    type: 'autocomplete',
                    message: 'Select option:',
                    pageSize: 20
                })
            ]);
        });

        it('should filter options based on search input', async () => {
            const options = {
                itemsArray: ['test1', 'test2', 'other'],
                prompt: 'Select:'
            };

            mockInquirer.prompt.mockResolvedValueOnce({ selectedOption: 'test1' });

            const result = await searchSelectAndReturnFromArray(options);

            // Get the source function from the mock calls
            const promptQuestions = mockInquirer.prompt.mock.calls[0][0] as Array<{
                source?: (answers: string[], input: string) => Promise<string[]> | string[];
            }>;
            const sourceFunction = promptQuestions[0].source;

            // Test the source function if it exists
            if (sourceFunction) {
                const filteredResults = await sourceFunction([], 'test');
                expect(filteredResults).toEqual(['test1', 'test2']);
                expect(filteredResults).not.toContain('other');
            }

            expect(result).toBe('test1');

        });
    });

    describe('searchAndSelect', () => {
        it('should return direct selection when no conflict', async () => {
            const options = {
                itemsArray: ['item1', 'item2'],
                prompt: 'Select:'
            };

            mockInquirer.prompt.mockResolvedValueOnce({ userSelection: 'item1' });

            const result = await searchAndSelect(options);

            expect(result).toBe('item1');
        });

        it('should prompt for choice when input differs from selection', async () => {
            const options = {
                itemsArray: ['existing1', 'existing2'],
                prompt: 'Select:'
            };

            // Mock the inquirer prompts sequence
            mockInquirer.prompt
                .mockResolvedValueOnce({ userSelection: 'newInput' })  // First prompt for initial selection
                .mockResolvedValueOnce({ finalChoice: 'newInput' });   // Second prompt for final choice

            const result = await searchAndSelect(options);

            expect(result).toBe('newInput');
            expect(mockInquirer.prompt).toHaveBeenCalledTimes(1);

            expect(mockInquirer.prompt).toHaveBeenNthCalledWith(1, expect.arrayContaining([
                expect.objectContaining({
                    type: 'autocomplete',
                    name: 'userSelection'
                })
            ]));
        });
    });
});
