import * as bash from '@/utils/bashHelper';
import * as neovim from '@/utils/neovimHelper';
import { getCurrentBranch, getTopLevelPath, hardReset, getGitLog } from '@/git/core/gitBranch';
import { GIT_COMMANDS } from '@/git/config/gitConstants';

jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');

describe('Git Branch Operations', () => {
    const originalTmux = process.env.TMUX;
    const mockExecCommand = jest.mocked(bash.execCommand);
    const mockSendKeysToTmux = jest.mocked(bash.sendKeysToTmuxTargetSession);
    const mockOpenVim = jest.mocked(neovim.openVim);

    beforeEach(() => {
        jest.clearAllMocks();
        if (originalTmux === undefined) {
            delete process.env.TMUX;
        } else {
            process.env.TMUX = originalTmux;
        }
    });

    afterAll(() => {
        if (originalTmux === undefined) {
            delete process.env.TMUX;
        } else {
            process.env.TMUX = originalTmux;
        }
    });

    describe('getCurrentBranch', () => {
        it('should return current branch name', async () => {
            mockExecCommand.mockResolvedValue({ stdout: 'main\nanother line\n', stderr: '' });

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
            const topLevel = '/path/to/repo';
            mockExecCommand.mockResolvedValue({ stdout: `${topLevel}\nother info\n`, stderr: '' });

            const result = await getTopLevelPath();

            expect(result).toBe(topLevel);
            expect(mockExecCommand).toHaveBeenCalledWith(GIT_COMMANDS.GET_TOP_LEVEL);
        });
    });

    describe('hardReset', () => {
        it('should perform hard reset and show branch changes', async () => {
            const consoleSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
            mockExecCommand.mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // getCurrentBranch
                .mockResolvedValueOnce({ stdout: 'origin/branch1\n', stderr: '' }) // before fetch
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch
                .mockResolvedValueOnce({ stdout: 'origin/branch1\norigin/branch2\n', stderr: '' }) // after fetch
                .mockResolvedValueOnce({ stdout: 'HEAD is now at abc123', stderr: '' }); // reset

            await hardReset();

            expect(mockExecCommand).toHaveBeenNthCalledWith(1, GIT_COMMANDS.GET_BRANCH);
            expect(mockExecCommand).toHaveBeenNthCalledWith(2, GIT_COMMANDS.GET_REMOTE_BRANCHES);
            expect(mockExecCommand).toHaveBeenNthCalledWith(3, 'git fetch --prune');
            expect(mockExecCommand).toHaveBeenNthCalledWith(4, GIT_COMMANDS.GET_REMOTE_BRANCHES);
            expect(mockExecCommand).toHaveBeenNthCalledWith(5, 'git reset --hard origin/main');
            expect(consoleSpy).toHaveBeenCalledWith({
                HEAD: 'HEAD is now at abc123',
                '': '=======================',
                'Fetched Branches': ['origin/branch2'],
                'Pruned Branches': []
            });

            consoleSpy.mockRestore();
        });

        it('should handle errors during reset', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            mockExecCommand.mockRejectedValue(new Error('Network error'));

            await hardReset();

            expect(consoleSpy).toHaveBeenCalledWith('Failed to reset branch:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe('getGitLog', () => {
        it('should open git log in tmux when TMUX is set', async () => {
            process.env.TMUX = '1';
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await getGitLog();

            expect(mockExecCommand).toHaveBeenCalledWith(expect.stringContaining('git log --graph'));
            expect(mockSendKeysToTmux).toHaveBeenCalledWith({
                command: expect.stringContaining('nvim -c \'set filetype=git\'')
            });
            expect(mockOpenVim).not.toHaveBeenCalled();
        });

        it('should open git log with openVim when TMUX is not set', async () => {
            delete process.env.TMUX;
            mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

            await getGitLog();

            expect(mockExecCommand).toHaveBeenCalledWith(expect.stringContaining('git log --graph'));
            expect(mockOpenVim).toHaveBeenCalledWith('/tmp/git-log-XXXXXX.txt', '-c', 'set filetype=git');
            expect(mockSendKeysToTmux).not.toHaveBeenCalled();
        });

        it('should handle errors when getting git log', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            mockExecCommand.mockRejectedValue(new Error('Git log failed'));

            await getGitLog();

            expect(consoleSpy).toHaveBeenCalledWith('Failed to run git log or open nvim:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });
});
