import * as bash from '../src/utils/bashHelper';
import {
    getFileList,
    getModifiedFiles,
    getUntrackedFiles,
    getConflictedFiles,
    getStashes
} from '../src/git/utils/gitFileUtils';
import { GIT_COMMANDS } from '../src/git/config/gitConstants';

jest.mock('../src/utils/bashHelper');

describe('Git File Utils', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getFileList', () => {
        it('should return array of files from command output', async () => {
            const files = ['file1.ts', 'file2.ts', 'file3.ts'];
            mockExecCommand.mockResolvedValue({ stdout: files.join('\n'), stderr: '' });

            const result = await getFileList('test-command');

            expect(result).toEqual(files);
        });

        it('should filter out empty lines', async () => {
            mockExecCommand.mockResolvedValue({ stdout: 'file1.ts\n\nfile2.ts\n\n', stderr: '' });

            const result = await getFileList('test-command');

            expect(result).toEqual(['file1.ts', 'file2.ts']);
        });

        it('should handle undefined response', async () => {
            mockExecCommand.mockResolvedValue(undefined as any);

            const result = await getFileList('test-command');

            expect(result).toEqual([]);
        });

        it('should handle null stdout', async () => {
            mockExecCommand.mockResolvedValue({ stdout: null as any, stderr: '' });

            const result = await getFileList('test-command');

            expect(result).toEqual([]);
        });

        it('should handle empty stdout', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const result = await getFileList('test-command');

            expect(result).toEqual([]);
        });
    });

    describe('file status utilities', () => {
        it('should get modified files', async () => {
            const files = ['modified1.ts', 'modified2.ts'];
            mockExecCommand.mockResolvedValue({ stdout: files.join('\n'), stderr: '' });

            const result = await getModifiedFiles();

            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_MODIFIED);
            expect(result).toEqual(files);
        });

        it('should get untracked files', async () => {
            const files = ['untracked1.ts', 'untracked2.ts'];
            mockExecCommand.mockResolvedValue({ stdout: files.join('\n'), stderr: '' });

            const result = await getUntrackedFiles();

            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_UNTRACKED);
            expect(result).toEqual(files);
        });

        it('should get conflicted files', async () => {
            const files = ['conflict1.ts', 'conflict2.ts'];
            mockExecCommand.mockResolvedValue({ stdout: files.join('\n'), stderr: '' });

            const result = await getConflictedFiles();

            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_CONFLICTS);
            expect(result).toEqual(files);
        });

        it('should get stashes', async () => {
            const stashes = ['stash@{0}: WIP', 'stash@{1}: feature'];
            mockExecCommand.mockResolvedValue({ stdout: stashes.join('\n'), stderr: '' });

            const result = await getStashes();

            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_STASHES);
            expect(result).toEqual(stashes);
        });

        it('should handle no modified files', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const result = await getModifiedFiles();

            expect(result).toEqual([]);
        });

        it('should handle no untracked files', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const result = await getUntrackedFiles();

            expect(result).toEqual([]);
        });

        it('should handle no conflicted files', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const result = await getConflictedFiles();

            expect(result).toEqual([]);
        });

        it('should handle no stashes', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            const result = await getStashes();

            expect(result).toEqual([]);
        });
    });
});
