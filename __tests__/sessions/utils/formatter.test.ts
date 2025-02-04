import { formatPane, formatWindow } from '@sessions/utils/formatters';
import * as bash from '@utils/bashHelper';

jest.mock('@utils/bashHelper');

describe('formatters', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('formatPane', () => {
        it('should format pane with git repo link', async () => {
            const paneString = 'vim:/home/user/project:0x0';
            mockExecCommand.mockResolvedValueOnce({ stdout: 'git@github.com:user/repo.git\n', stderr: '' });

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: 'vim',
                currentPath: '/home/user/project',
                gitRepoLink: 'git@github.com:user/repo.git',
                paneLeft: '0',
                paneTop: '0'
            });
            expect(mockExecCommand).toHaveBeenCalledWith(
                'git -C /home/user/project remote get-url origin'
            );
        });

        it('should format pane without git repo link', async () => {
            const paneString = 'bash:/home/user/project:0x0';
            mockExecCommand.mockRejectedValueOnce(new Error('Not a git repo'));

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: 'bash',
                currentPath: '/home/user/project',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            });
        });
    });

    describe('formatWindow', () => {
        it('should format window with git repo link', async () => {
            const windowString = 'main:vim:/home/user/project:main-vertical';
            mockExecCommand.mockResolvedValueOnce({ stdout: 'git@github.com:user/repo.git\n', stderr: '' });

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'main',
                currentCommand: 'vim',
                currentPath: '/home/user/project',
                layout: 'main-vertical',
                gitRepoLink: 'git@github.com:user/repo.git',
                panes: []
            });
        });

        it('should format window without git repo link', async () => {
            const windowString = 'main:vim:/home/user/project:main-vertical';
            mockExecCommand.mockRejectedValueOnce(new Error('Not a git repo'));

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'main',
                currentCommand: 'vim',
                currentPath: '/home/user/project',
                layout: 'main-vertical',
                gitRepoLink: undefined,
                panes: []
            });
        });
    });
});
