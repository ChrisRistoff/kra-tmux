import * as bash from '@utils/bashHelper';
import * as ui from '@UI/generalUI';
import * as vim from '@utils/neovimHelper';
import { handleConflicts } from '@git/commands/gitConflicts';
import { restoreFile } from '@git/commands/gitRestore';
import { applyOrDropStash, dropMultipleStashes } from '@git/commands/gitStash';
import { GIT_COMMANDS } from '@git/config/gitConstants';

// Mock dependencies
jest.mock('../../src/utils/bashHelper');
jest.mock('../../src/UI/generalUI');
jest.mock('../../src/utils/neovimHelper');

describe('Git Commands', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockSearchSelect = jest.mocked(ui.searchSelectAndReturnFromArray);
    const mockOpenVim = jest.mocked(vim.openVim);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('handleConflicts', () => {
        it('should handle no conflicts scenario', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '' }); // No conflicted files

            const consoleSpy = jest.spyOn(console, 'log');

            await handleConflicts();

            expect(consoleSpy).toHaveBeenCalledWith('No Conflicts to Handle!');
            expect(mockOpenVim).not.toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        it('should handle conflicts resolution', async () => {
            const conflictedFile = 'src/test.ts';

            mockExecCommand
                .mockResolvedValueOnce({ stdout: conflictedFile + '\n', stderr: '' }) // Initial conflicts check
                .mockResolvedValueOnce({ stdout: '', stderr: '' }); // No conflicts after resolution

            mockSearchSelect.mockResolvedValueOnce(conflictedFile);

            await handleConflicts();

            expect(mockOpenVim).toHaveBeenCalledWith(conflictedFile, ':Gvdiffsplit!');
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_CONFLICTS);
        });
    });

    describe('restoreFile', () => {
        it('should restore all files when "All" is selected', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: 'file1.ts\nfile2.ts', stderr: '' });
            mockSearchSelect.mockResolvedValueOnce('All');

            await restoreFile();

            expect(mockExecCommand).toHaveBeenLastCalledWith('git restore ./');
        });

        it('should restore specific file when selected', async () => {
            const fileToRestore = 'src/test.ts';
            mockExecCommand.mockResolvedValueOnce({ stdout: fileToRestore + '\n', stderr: '' });
            mockSearchSelect.mockResolvedValueOnce(fileToRestore);

            await restoreFile();

            expect(mockExecCommand).toHaveBeenLastCalledWith(`git restore ${fileToRestore}`);
        });

        it('should handle empty selection', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: 'file1.ts\n', stderr: '' });
            mockSearchSelect.mockResolvedValueOnce('');

            await restoreFile();

            expect(mockExecCommand).toHaveBeenCalledTimes(1); // Only the initial files check
        });
    });

    describe('stash operations', () => {
        describe('applyOrDropStash', () => {
            it('should apply selected stash', async () => {
                const stashList = ['stash@{0}: WIP on main', 'stash@{1}: feature work'];

                mockExecCommand.mockResolvedValueOnce({ stdout: stashList.join('\n'), stderr: '' });
                mockSearchSelect
                    .mockResolvedValueOnce(stashList[0]) // Select first stash
                    .mockResolvedValueOnce('apply'); // Choose to apply

                await applyOrDropStash();

                expect(mockExecCommand).toHaveBeenLastCalledWith('git stash apply stash@{0}');
            });

            it('should drop selected stash', async () => {
                const stashList = ['stash@{0}: WIP on main'];

                mockExecCommand.mockResolvedValueOnce({ stdout: stashList.join('\n'), stderr: '' });
                mockSearchSelect
                    .mockResolvedValueOnce(stashList[0])
                    .mockResolvedValueOnce('drop');

                await applyOrDropStash();

                expect(mockExecCommand).toHaveBeenLastCalledWith('git stash drop stash@{0}');
            });
        });

        describe('dropMultipleStashes', () => {
            it('should drop multiple stashes until stop is selected', async () => {
                const stashList = ['stash@{0}: WIP', 'stash@{1}: feature'];

                mockExecCommand
                    .mockResolvedValueOnce({ stdout: stashList.join('\n'), stderr: '' })
                    .mockResolvedValueOnce({ stdout: stashList[1], stderr: '' });

                mockSearchSelect
                    .mockResolvedValueOnce(stashList[0]) // Select first stash
                    .mockResolvedValueOnce('stop'); // Stop after first drop

                await dropMultipleStashes();

                expect(mockExecCommand).toHaveBeenCalledWith('git stash drop stash@{0}');
            });
        });
    });
});
