import * as bash from '@/utils/bashHelper';
import * as ui from '@/UI/generalUI';
import { handleConflicts } from '@/git/commands/gitConflicts';
import { restoreFile } from '@/git/commands/gitRestore';
import { applyOrDropStash, dropMultipleStashes } from '@/git/commands/gitStash';
import { pickList } from '@/UI/dashboard/pickList';
import { browseFiles, runInherit } from '@/UI/dashboard/screen';
import {
    allFiles,
    getConflictedFiles,
    getModifiedFiles,
    getStashes,
} from '@/git/utils/gitFileUtils';

jest.mock('@/utils/bashHelper');
jest.mock('@/UI/generalUI');
jest.mock('@/UI/dashboard/pickList', () => ({ pickList: jest.fn() }));
jest.mock('@/UI/dashboard/screen', () => ({
    browseFiles: jest.fn(),
    runInherit: jest.fn(),
    withTempScreen: jest.fn(async (_title: string, cb: (screen: unknown) => Promise<void>) => cb({})),
}));
jest.mock('@/git/utils/gitFileUtils', () => ({
    allFiles: 'All',
    getConflictedFiles: jest.fn(),
    getModifiedFiles: jest.fn(),
    getStashes: jest.fn(),
}));

describe('Git Commands', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockGrepFileForString = jest.mocked(bash.grepFileForString);
    const mockSearchSelect = jest.mocked(ui.searchSelectAndReturnFromArray);
    const mockPickList = jest.mocked(pickList);
    const mockBrowseFiles = jest.mocked(browseFiles);
    const mockRunInherit = jest.mocked(runInherit);
    const mockGetConflictedFiles = jest.mocked(getConflictedFiles);
    const mockGetModifiedFiles = jest.mocked(getModifiedFiles);
    const mockGetStashes = jest.mocked(getStashes);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('handleConflicts', () => {
        it('should handle no conflicts scenario', async () => {
            mockGetConflictedFiles.mockResolvedValueOnce([]);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

            await handleConflicts();

            expect(consoleSpy).toHaveBeenCalledWith('No Conflicts to Handle!');
            expect(mockBrowseFiles).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('should handle conflicts resolution', async () => {
            const conflictedFile = 'src/test.ts';
            mockGetConflictedFiles.mockResolvedValueOnce([conflictedFile]);
            mockGrepFileForString.mockResolvedValueOnce(false);
            mockBrowseFiles.mockImplementationOnce(async (_screen, opts) => {
                await opts.view(conflictedFile);
            });
            jest.spyOn(console, 'table').mockImplementation(() => undefined);

            await handleConflicts();

            expect(mockRunInherit).toHaveBeenCalledWith('nvim', [conflictedFile, '-c', 'Gvdiffsplit!'], expect.anything());
            expect(mockGrepFileForString).toHaveBeenCalledWith(conflictedFile, '<<<<<<<|=======|>>>>>>>');
        });
    });

    describe('restoreFile', () => {
        it('should restore all files when "All" is selected', async () => {
            mockGetModifiedFiles.mockResolvedValueOnce(['file1.ts', 'file2.ts']);
            mockSearchSelect.mockResolvedValueOnce(allFiles);

            await restoreFile();

            expect(mockExecCommand).toHaveBeenLastCalledWith('git restore ./');
        });

        it('should restore specific file when selected', async () => {
            const fileToRestore = 'src/test.ts';
            mockGetModifiedFiles.mockResolvedValueOnce([fileToRestore]);
            mockSearchSelect.mockResolvedValueOnce(fileToRestore);

            await restoreFile();

            expect(mockExecCommand).toHaveBeenLastCalledWith(`git restore ${fileToRestore}`);
        });

        it('should handle empty selection', async () => {
            mockGetModifiedFiles.mockResolvedValueOnce(['file1.ts']);
            mockSearchSelect.mockResolvedValueOnce('');

            await restoreFile();

            expect(mockExecCommand).not.toHaveBeenCalled();
        });
    });

    describe('stash operations', () => {
        describe('applyOrDropStash', () => {
            it('should apply selected stash', async () => {
                const stashList = ['stash@{0}: WIP on main', 'stash@{1}: feature work'];
                mockGetStashes.mockResolvedValueOnce(stashList);
                mockPickList
                    .mockResolvedValueOnce({ value: stashList[0] })
                    .mockResolvedValueOnce({ value: 'apply' });

                await applyOrDropStash();

                expect(mockExecCommand).toHaveBeenLastCalledWith('git stash apply stash@{0}');
            });

            it('should drop selected stash', async () => {
                const stashList = ['stash@{0}: WIP on main'];
                mockGetStashes.mockResolvedValueOnce(stashList);
                mockPickList
                    .mockResolvedValueOnce({ value: stashList[0] })
                    .mockResolvedValueOnce({ value: 'drop' });

                await applyOrDropStash();

                expect(mockExecCommand).toHaveBeenLastCalledWith('git stash drop stash@{0}');
            });
        });

        describe('dropMultipleStashes', () => {
            it('should drop multiple stashes until stop is selected', async () => {
                const stashList = ['stash@{0}: WIP', 'stash@{1}: feature'];
                mockGetStashes
                    .mockResolvedValueOnce(stashList)
                    .mockResolvedValueOnce([stashList[1]]);
                mockPickList
                    .mockResolvedValueOnce({ value: stashList[0] })
                    .mockResolvedValueOnce({ value: 'stop' });

                await dropMultipleStashes();

                expect(mockExecCommand).toHaveBeenCalledWith('git stash drop stash@{0}');
            });
        });
    });
});