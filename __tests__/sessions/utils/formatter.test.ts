import { formatPane, formatWindow } from '@/tmux/utils/formatters';
import * as bash from '@/utils/bashHelper';

jest.mock('@/utils/bashHelper');

describe('formatters', () => {
    const mockExecCommand = jest.mocked(bash.execCommand);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('formatPane', () => {
        it('should format pane with git repo and foreground command', async () => {
            const paneString = '1234:/home/user/project:10x20';

            // Mock git repo call
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'git@github.com:user/repo.git\n',
                stderr: ''
            });

            // Mock foreground command calls
            mockExecCommand.mockResolvedValueOnce({
                stdout: '5678\n9999\n',
                stderr: ''
            });
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'vim\n',
                stderr: ''
            });

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: 'vim',
                currentPath: '/home/user/project',
                gitRepoLink: 'git@github.com:user/repo.git',
                paneLeft: '10',
                paneTop: '20'
            });

            expect(mockExecCommand).toHaveBeenCalledWith('git -C /home/user/project remote get-url origin');
            expect(mockExecCommand).toHaveBeenCalledWith('pgrep -P 1234');
            expect(mockExecCommand).toHaveBeenCalledWith('ps -p 9999 -o comm=');
        });

        it('should format pane without git repo', async () => {
            const paneString = '2345:/tmp:0x0';

            // Mock git repo call failure
            mockExecCommand.mockRejectedValueOnce(new Error('Not a git repo'));

            // Mock foreground command calls
            mockExecCommand.mockResolvedValueOnce({
                stdout: '6789\n',
                stderr: ''
            });
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'bash\n',
                stderr: ''
            });

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: 'bash',
                currentPath: '/tmp',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            });
        });

        it('should handle pane with no foreground command', async () => {
            const paneString = '3456:/home/user:5x15';

            // Mock git repo call
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'https://github.com/user/project.git\n',
                stderr: ''
            });

            // Mock no child processes
            mockExecCommand.mockResolvedValueOnce({
                stdout: '\n',
                stderr: ''
            });

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: '',
                currentPath: '/home/user',
                gitRepoLink: 'https://github.com/user/project.git',
                paneLeft: '5',
                paneTop: '15'
            });
        });

        it('should handle errors in foreground command detection', async () => {
            const paneString = '4567:/var/log:100x200';

            // Mock git repo call
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'git@gitlab.com:org/repo.git\n',
                stderr: ''
            });

            // Mock pgrep failure
            mockExecCommand.mockRejectedValueOnce(new Error('Process not found'));

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: '',
                currentPath: '/var/log',
                gitRepoLink: 'git@gitlab.com:org/repo.git',
                paneLeft: '100',
                paneTop: '200'
            });
        });

        it('should handle ps command failure', async () => {
            const paneString = '5678:/opt/app:25x50';

            // Mock git repo call
            mockExecCommand.mockResolvedValueOnce({
                stdout: 'ssh://git@example.com/repo.git\n',
                stderr: ''
            });

            // Mock pgrep success but ps failure
            mockExecCommand.mockResolvedValueOnce({
                stdout: '1111\n2222\n',
                stderr: ''
            });
            mockExecCommand.mockRejectedValueOnce(new Error('Process info unavailable'));

            const result = await formatPane(paneString);

            expect(result).toEqual({
                currentCommand: '',
                currentPath: '/opt/app',
                gitRepoLink: 'ssh://git@example.com/repo.git',
                paneLeft: '25',
                paneTop: '50'
            });
        });
    });

    describe('formatWindow', () => {
        it('should format window with git repo', async () => {
            const windowString = 'main:nvim:/home/user/project:main-vertical';

            mockExecCommand.mockResolvedValueOnce({
                stdout: 'git@github.com:user/repo.git\n',
                stderr: ''
            });

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'main',
                layout: 'main-vertical',
                gitRepoLink: 'git@github.com:user/repo.git',
                currentCommand: 'nvim',
                currentPath: '/home/user/project',
                panes: []
            });

            expect(mockExecCommand).toHaveBeenCalledWith('git -C /home/user/project remote get-url origin');
        });

        it('should format window without git repo', async () => {
            const windowString = 'editor:code:/workspace:tiled';

            mockExecCommand.mockRejectedValueOnce(new Error('fatal: not a git repository'));

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'editor',
                layout: 'tiled',
                gitRepoLink: undefined,
                currentCommand: 'code',
                currentPath: '/workspace',
                panes: []
            });
        });

        it('should handle window with complex names', async () => {
            const windowString = 'my-app-server:node:/srv/myapp:even-horizontal';

            mockExecCommand.mockResolvedValueOnce({
                stdout: 'https://bitbucket.org/team/myapp.git\n',
                stderr: ''
            });

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'my-app-server',
                layout: 'even-horizontal',
                gitRepoLink: 'https://bitbucket.org/team/myapp.git',
                currentCommand: 'node',
                currentPath: '/srv/myapp',
                panes: []
            });
        });

        it('should handle window with empty command', async () => {
            const windowString = 'terminal::/home/user:main-horizontal';

            mockExecCommand.mockResolvedValueOnce({
                stdout: 'git@codeberg.org:user/project.git\n',
                stderr: ''
            });

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'terminal',
                layout: 'main-horizontal',
                gitRepoLink: 'git@codeberg.org:user/project.git',
                currentCommand: '',
                currentPath: '/home/user',
                panes: []
            });
        });

        it('should handle window with multi-line git output', async () => {
            const windowString = 'dev:python:/dev/project:manual';

            mockExecCommand.mockResolvedValueOnce({
                stdout: 'origin\tgit@github.com:dev/project.git (fetch)\norigin\tgit@github.com:dev/project.git (push)\n',
                stderr: ''
            });

            const result = await formatWindow(windowString);

            expect(result).toEqual({
                windowName: 'dev',
                layout: 'manual',
                gitRepoLink: 'origin\tgit@github.com:dev/project.git (fetch)',
                currentCommand: 'python',
                currentPath: '/dev/project',
                panes: []
            });
        });
    });
});
