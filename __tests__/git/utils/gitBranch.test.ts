import * as bash from '@utils/bashHelper';
import { getCurrentBranch, getTopLevelPath, hardReset, getGitLog } from '@git/core/gitBranch';
import { GIT_COMMANDS } from '@git/config/gitConstants';

jest.mock('@utils/bashHelper');

describe('gitBranch', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockSendKeysToTmux = jest.spyOn(bash, 'sendKeysToTmuxTargetSession');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getCurrentBranch', () => {
        it('should return the first line of stdout from the branch command', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: 'main\nanother line\n', stderr: '' });
            const branch = await getCurrentBranch();
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_BRANCH);
            expect(branch).toBe('main');
        });
    });

    describe('getTopLevelPath', () => {
        it('should return the first line of stdout from the top-level command', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: '/path/to/repo\nother info\n', stderr: '' });
            const topLevel = await getTopLevelPath();
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_TOP_LEVEL);
            expect(topLevel).toBe('/path/to/repo');
        });
    });

    describe('hardReset', () => {
        let consoleTableSpy: jest.SpyInstance;
        let consoleErrorSpy: jest.SpyInstance;

        beforeEach(() => {
            consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
            consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleTableSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        });

        it('should perform a hard reset and display fetched and pruned branches', async () => {
            mockExecCommand
                .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // getCurrentBranch
                .mockResolvedValueOnce({ stdout: 'branchA\nbranchB\n', stderr: '' }) // before fetch branches
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git fetch --prune (dummy)
                .mockResolvedValueOnce({ stdout: 'branchA\nbranchB\nbranchC\n', stderr: '' }) // after fetch branches
                .mockResolvedValueOnce({ stdout: 'Reset successful\n', stderr: '' }); // git reset

            await hardReset();

            expect(mockExecCommand).toHaveBeenNthCalledWith(1, GIT_COMMANDS.GET_BRANCH);
            expect(mockExecCommand).toHaveBeenNthCalledWith(2, GIT_COMMANDS.GET_REMOTE_BRANCHES);
            expect(mockExecCommand).toHaveBeenNthCalledWith(3, 'git fetch --prune');
            expect(mockExecCommand).toHaveBeenNthCalledWith(4, GIT_COMMANDS.GET_REMOTE_BRANCHES);
            expect(mockExecCommand).toHaveBeenNthCalledWith(5, 'git reset --hard origin/main');

            expect(consoleTableSpy).toHaveBeenCalledWith({
                HEAD: 'Reset successful\n',
                '': '=======================',
                'Fetched Branches': ['branchC'],
                'Pruned Branches': []
            });
        });

        it('should catch an error and log it if one occurs', async () => {
            const error = new Error('Test error');
            mockExecCommand.mockRejectedValueOnce(error);
            await hardReset();
            expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to reset branch:", error);
        });
    });

    describe('getGitLog', () => {
        let consoleErrorSpy: jest.SpyInstance;

        beforeEach(() => {
            consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleErrorSpy.mockRestore();
        });

        it('should run git log command and open nvim with the generated tmpfile', async () => {
            const fakeLogOutput = 'log output';
            mockExecCommand.mockResolvedValueOnce({ stdout: fakeLogOutput, stderr: '' });
            mockSendKeysToTmux.mockResolvedValueOnce(undefined);

            await getGitLog();

            expect(mockExecCommand.mock.calls[0][0]).toMatch(/git log --graph/);
            expect(mockSendKeysToTmux).toHaveBeenCalled();

            const sendKeysArgs = mockSendKeysToTmux.mock.calls[0][0];
            expect(sendKeysArgs.command).toMatch(/nvim -c 'set filetype=git' \/tmp\/git-log-XXXXXX.txt/);
        });

        it('should catch an error and log it if git log fails', async () => {
            const error = new Error('Log error');
            mockExecCommand.mockRejectedValueOnce(error);
            await getGitLog();
            expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to run git log or open nvim:', error);
        });
    });
});
