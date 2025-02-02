import * as bash from '../src/utils/bashHelper';
import * as ui from '../src/UI/generalUI';
import { removeFile, removeDirectory } from '../src/system/systemFileManager';


jest.mock('../src/utils/bashHelper');
jest.mock('../src/UI/generalUI');

describe('SystemFileManager', () => {

    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockAskUserForInput = jest.mocked(ui.askUserForInput);
    const mockPromptYesOrNo = jest.mocked(ui.promptUserYesOrNo);
    const mockSearchSelectAndReturnFromArray = jest.mocked(ui.searchSelectAndReturnFromArray);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('File Operations', () => {
        it('should construct correct find command for file search', async () => {
            mockAskUserForInput.mockResolvedValue('test');
            mockPromptYesOrNo.mockResolvedValue(false); // non-exact match
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await removeFile();

            expect(mockExecCommand).toHaveBeenCalledWith('find . -type f -iname "*test*"');
        });

        it('should construct correct remove command for file', async () => {
            const testFile = './test.txt';
            mockAskUserForInput.mockResolvedValue('test');
            mockPromptYesOrNo.mockResolvedValueOnce(true) // exact match
                            .mockResolvedValueOnce(true);  // confirm deletion
            mockExecCommand.mockResolvedValueOnce({ stdout: testFile, stderr: '' })
                          .mockResolvedValueOnce({ stdout: '', stderr: '' });
            mockSearchSelectAndReturnFromArray.mockResolvedValue(testFile);

            await removeFile();

            expect(mockExecCommand).toHaveBeenLastCalledWith(`rm "${testFile}"`);
        });

        it('should validate minimum search length for files', async () => {
            mockAskUserForInput.mockResolvedValue('a');

            await expect(removeFile()).rejects.toThrow('Search term must be at least 2 characters long');
            expect(mockExecCommand).not.toHaveBeenCalled();
        });
    });

    describe('Directory Operations', () => {
        it('should construct correct find command for directory search', async () => {
            mockAskUserForInput.mockResolvedValue('test');
            mockPromptYesOrNo.mockResolvedValue(false); // non-exact match
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await removeDirectory();

            expect(mockExecCommand).toHaveBeenCalledWith('find . -type d -iname "*test*"');
        });

        it('should construct correct remove command for directory', async () => {
            const testDir = './testdir';
            mockAskUserForInput.mockResolvedValue('test');
            mockPromptYesOrNo.mockResolvedValueOnce(true) // exact match
                            .mockResolvedValueOnce(true);  // confirm deletion
            mockExecCommand.mockResolvedValueOnce({ stdout: testDir, stderr: '' })
                          .mockResolvedValueOnce({ stdout: '', stderr: '' });
            mockSearchSelectAndReturnFromArray.mockResolvedValue(testDir);

            await removeDirectory();

            expect(mockExecCommand).toHaveBeenLastCalledWith(`rm -rf "${testDir}"`);
        });
    });

    describe('Error Handling', () => {
        it('should handle command execution errors', async () => {
            mockAskUserForInput.mockResolvedValue('test');
            mockPromptYesOrNo.mockResolvedValueOnce(true)
                            .mockResolvedValueOnce(true);
            mockExecCommand.mockResolvedValueOnce({ stdout: './test', stderr: '' })
                          .mockRejectedValueOnce(new Error('Permission denied'));
            mockSearchSelectAndReturnFromArray.mockResolvedValue('./test');

            await expect(removeDirectory()).rejects.toThrow('Failed to remove directory: Permission denied');
        });

        it('should handle empty search results', async () => {
            mockAskUserForInput.mockResolvedValue('nonexistent');
            mockPromptYesOrNo.mockResolvedValue(true);
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const consoleSpy = jest.spyOn(console, 'log');
            await removeFile();

            expect(consoleSpy).toHaveBeenCalledWith('No matches found for the given search criteria.');
            consoleSpy.mockRestore();
        });
    });

    describe('Security', () => {
        it('should sanitize search input while preserving command structure', async () => {
            const maliciousInput = 'test";rm -rf /;"';

            mockAskUserForInput.mockResolvedValue(maliciousInput);
            mockPromptYesOrNo.mockResolvedValue(false); // non-exact match
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await removeFile();

            // The command should contain the sanitized version of the input
            expect(mockExecCommand).toHaveBeenCalledWith(
                'find . -type f -iname "*test;rm -rf /;*"'
            );
        });

        it('should remove dangerous characters from search input', async () => {
            const inputWithSpecialChars = 'test\'"\\file';
            const expectedSanitized = 'testfile';

            mockAskUserForInput.mockResolvedValue(inputWithSpecialChars);
            mockPromptYesOrNo.mockResolvedValue(true); // exact match
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await removeFile();

            expect(mockExecCommand).toHaveBeenCalledWith(
                `find . -type f -iname "${expectedSanitized}"`
            );
        });

    });
});
