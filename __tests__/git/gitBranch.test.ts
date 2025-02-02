import * as bash from '@utils/bashHelper';
import { getCurrentBranch, getTopLevelPath, hardReset, getGitLog } from '@git/core/gitBranch';
import { GIT_COMMANDS } from '@git/config/gitConstants';

jest.mock('@utils/bashHelper');

describe('Git Branch Operations', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockSendKeysToTmux = jest.mocked(bash.sendKeysToTmuxTargetSession);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getCurrentBranch', () => {
        it('should return current branch name', async () => {
            mockExecCommand.mockResolvedValue({ stdout: 'main\n', stderr: '' });

            const result = await getCurrentBranch();

            expect(result).toBe('main');
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_BRANCH);
        });

        it('should handle error when getting branch name', async () => {
            mockExecCommand.mockRejectedValue(new Error('Not a git repository'));

            await expect(getCurrentBranch()).rejects.toThrow('Not a git repository');
        });
    });

    describe('getTopLevelPath', () => {
        it('should return top level git path', async () => {
            const topLevel = '/home/user/project';
            mockExecCommand.mockResolvedValue({ stdout: `${topLevel}\n`, stderr: '' });

            const result = await getTopLevelPath();

            expect(result).toBe(topLevel);
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_TOP_LEVEL);
        });
    });

    describe('hardReset', () => {
        it('should perform hard reset and show branch changes', async () => {
            const consoleSpy = jest.spyOn(console, 'table');
            mockExecCommand.mockResolvedValueOnce({ stdout: 'main', stderr: '' }) // getCurrentBranch
                .mockResolvedValueOnce({ stdout: 'origin/branch1\n', stderr: '' }) // before fetch
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch
                .mockResolvedValueOnce({ stdout: 'origin/branch1\norigin/branch2\n', stderr: '' }) // after fetch
                .mockResolvedValueOnce({ stdout: 'HEAD is now at abc123', stderr: '' }); // reset

            await hardReset();

            expect(mockExecCommand).toHaveBeenCalledWith('git fetch --prune');
            expect(mockExecCommand).toHaveBeenCalledWith('git reset --hard origin/main');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        it('should handle errors during reset', async () => {
            const consoleSpy = jest.spyOn(console, 'error');

            mockExecCommand.mockRejectedValue(new Error('Network error'));

            await hardReset();

            expect(consoleSpy).toHaveBeenCalledWith('Failed to reset branch:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe('getGitLog', () => {
        it('should open git log in nvim', async () => {
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await getGitLog();

            expect(mockExecCommand).toHaveBeenCalledWith(expect.stringContaining('git log --graph'));
            expect(mockSendKeysToTmux).toHaveBeenCalledWith({
                command: expect.stringContaining('nvim -c \'set filetype=git\'')
            });
        });

        it('should handle errors when getting git log', async () => {
            const consoleSpy = jest.spyOn(console, 'error');
            mockExecCommand.mockRejectedValue(new Error('Git log failed'));

            await getGitLog();

            expect(consoleSpy).toHaveBeenCalledWith('Failed to run git log or open nvim:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });
});
