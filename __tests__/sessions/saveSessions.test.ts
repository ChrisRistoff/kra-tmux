import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as generalUI from '@/UI/generalUI';
import { getCurrentSessions, getDateString } from '@/tmux/utils/sessionUtils';
import { TmuxSessions } from '@/types/sessionTypes';
import { filterGitKeep } from '@/utils/common';
import { updateCurrentSession } from '@/tmux/utils/common';
import { quickSave, saveSessionsToFile } from '@/tmux/commands/saveSessions';

jest.mock('fs/promises');
jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');
jest.mock('@/UI/generalUI');
jest.mock('@/tmux/utils/sessionUtils');
jest.mock('@/utils/common');
jest.mock('@/tmux/utils/common');
jest.mock('@/filePaths', () => ({
    nvimSessionsPath: '/mock/nvim/sessions',
    sessionFilesFolder: '/mock/session/files'
}));

describe('saveSessions', () => {
    const mockFs = jest.mocked(fs);
    const mockBash = jest.mocked(bash);
    const mockNvim = jest.mocked(nvim);
    const mockGeneralUI = jest.mocked(generalUI);
    const mockGetCurrentSessions = jest.mocked(getCurrentSessions);
    const mockGetDateString = jest.mocked(getDateString);
    const mockFilterGitKeep = jest.mocked(filterGitKeep);
    const mockUpdateCurrentSession = jest.mocked(updateCurrentSession);

    const mockSessions: TmuxSessions = {
        'dev-session': {
            windows: [
                {
                    windowName: 'editor',
                    layout: 'main-vertical',
                    currentCommand: 'nvim',
                    currentPath: '/home/user/project',
                    gitRepoLink: 'git@github.com:user/repo.git',
                    panes: [
                        {
                            currentCommand: 'nvim',
                            currentPath: '/home/user/project/src',
                            gitRepoLink: 'git@github.com:user/repo.git',
                            paneLeft: '0',
                            paneTop: '0'
                        },
                        {
                            currentCommand: 'bash',
                            currentPath: '/home/user/project',
                            gitRepoLink: 'git@github.com:user/repo.git',
                            paneLeft: '1',
                            paneTop: '0'
                        }
                    ]
                },
                {
                    windowName: 'terminal',
                    layout: '15x15x15',
                    currentCommand: 'bash',
                    currentPath: '/home/user',
                    gitRepoLink: undefined,
                    panes: [
                        {
                            currentCommand: 'htop',
                            currentPath: '/home/user',
                            gitRepoLink: undefined,
                            paneLeft: '0',
                            paneTop: '0'
                        }
                    ]
                }
            ]
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Default mock implementations
        mockFs.writeFile.mockResolvedValue();
        mockFs.readdir.mockResolvedValue([]);
        mockFs.rm.mockResolvedValue();
        mockBash.execCommand.mockResolvedValue({ stdout: '', stderr: '' });
        mockNvim.saveNvimSession.mockResolvedValue();
        mockGeneralUI.searchAndSelect.mockResolvedValue('test-session');
        mockGeneralUI.promptUserYesOrNo.mockResolvedValue(false);
        mockGetCurrentSessions.mockResolvedValue(mockSessions);
        mockGetDateString.mockReturnValue('2024-01-15');
        mockFilterGitKeep.mockImplementation((files) => files);
        mockUpdateCurrentSession.mockResolvedValue();
    });

    describe('quickSave', () => {
        it('should save sessions to file when sessions exist', async () => {
            await quickSave('quick-save-test');

            expect(mockGetCurrentSessions).toHaveBeenCalled();
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/quick-save-test',
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
        });

        it('should not save when no sessions exist', async () => {
            mockGetCurrentSessions.mockResolvedValue({});

            await quickSave('empty-sessions');

            expect(mockGetCurrentSessions).toHaveBeenCalled();
            expect(mockFs.writeFile).not.toHaveBeenCalled();
        });

        it('should handle complex session data', async () => {
            const complexSessions: TmuxSessions = {
                'session1': {
                    windows: [
                        {
                            windowName: 'main',
                            layout: 'tiled',
                            currentCommand: 'vim',
                            currentPath: '/workspace',
                            gitRepoLink: 'https://github.com/test/repo.git',
                            panes: [
                                {
                                    currentCommand: 'vim',
                                    currentPath: '/workspace/src',
                                    gitRepoLink: 'https://github.com/test/repo.git',
                                    paneLeft: '0',
                                    paneTop: '0'
                                }
                            ]
                        }
                    ]
                },
                'session2': {
                    windows: [
                        {
                            windowName: 'logs',
                            layout: '15x15x15',
                            currentCommand: 'tail',
                            currentPath: '/var/log',
                            gitRepoLink: undefined,
                            panes: [
                                {
                                    currentCommand: 'tail',
                                    currentPath: '/var/log',
                                    gitRepoLink: undefined,
                                    paneLeft: '0',
                                    paneTop: '0'
                                }
                            ]
                        }
                    ]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(complexSessions);

            await quickSave('complex-save');

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/complex-save',
                JSON.stringify(complexSessions, null, 2),
                'utf-8'
            );
        });
    });

    describe('saveSessionsToFile', () => {
        it('should save sessions with user-provided filename', async () => {
            mockGeneralUI.searchAndSelect.mockResolvedValue('my-session');
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await saveSessionsToFile();

            expect(mockGetCurrentSessions).toHaveBeenCalled();
            expect(mockGeneralUI.searchAndSelect).toHaveBeenCalled();
            expect(mockNvim.saveNvimSession).toHaveBeenCalledWith('my-session', 'dev-session', 0, 0);
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/my-session',
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
            expect(mockUpdateCurrentSession).toHaveBeenCalledWith('my-session');
            expect(consoleSpy).toHaveBeenCalledWith('Save Successful!');

            consoleSpy.mockRestore();
        });

        it('should not save when no sessions exist', async () => {
            mockGetCurrentSessions.mockResolvedValue({});
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await saveSessionsToFile();

            expect(consoleSpy).toHaveBeenCalledWith('No sessions found to save!');
            expect(mockFs.writeFile).not.toHaveBeenCalled();
            expect(mockNvim.saveNvimSession).not.toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        it('should use git branch name when user chooses to', async () => {
            const branchName = 'feature/new-feature';
            const userInput = 'work-session';

            mockBash.execCommand.mockResolvedValue({ stdout: `${branchName}\n`, stderr: '' });
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(true);
            mockGeneralUI.searchAndSelect.mockResolvedValue(userInput);
            mockFilterGitKeep.mockReturnValue(['existing-session', 'another-session']);

            await saveSessionsToFile();

            const expectedFileName = `${branchName}-${userInput}-2024-01-15`;

            expect(mockBash.execCommand).toHaveBeenCalledWith('git rev-parse --abbrev-ref HEAD');
            expect(mockGeneralUI.promptUserYesOrNo).toHaveBeenCalledWith(
                `Would you like to use ${branchName} as part of your name for your save?`
            );
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                `/mock/session/files/${expectedFileName}`,
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
            expect(mockUpdateCurrentSession).toHaveBeenCalledWith(expectedFileName);
        });

        it('should handle git command failure gracefully', async () => {
            mockBash.execCommand.mockRejectedValue(new Error('Not a git repository'));
            mockGeneralUI.searchAndSelect.mockResolvedValue('manual-session');

            await saveSessionsToFile();

            expect(mockGeneralUI.searchAndSelect).toHaveBeenCalledWith({
                itemsArray: [],
                prompt: 'Please write a name for save: ',
            });
            expect(mockGeneralUI.promptUserYesOrNo).not.toHaveBeenCalled();
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/manual-session',
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
        });

        it('should not use git branch when user declines', async () => {
            const branchName = 'main';

            mockBash.execCommand.mockResolvedValue({ stdout: `${branchName}\n`, stderr: '' });
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(false);
            mockGeneralUI.searchAndSelect.mockResolvedValue('custom-session');
            mockFilterGitKeep.mockReturnValue(['session1', 'session2']);

            await saveSessionsToFile();

            expect(mockGeneralUI.promptUserYesOrNo).toHaveBeenCalledWith(
                `Would you like to use ${branchName} as part of your name for your save?`
            );
            expect(mockGeneralUI.searchAndSelect).toHaveBeenCalledWith({
                prompt: 'Please write a name for save: ',
                itemsArray: ['session1', 'session2'],
            });
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/custom-session',
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
        });

        it('should save neovim sessions only for nvim panes', async () => {
            const mixedSessions: TmuxSessions = {
                'mixed-session': {
                    windows: [
                        {
                            windowName: 'editor',
                            layout: 'main-vertical',
                            currentCommand: 'nvim',
                            currentPath: '/project',
                            gitRepoLink: undefined,
                            panes: [
                                {
                                    currentCommand: 'nvim',
                                    currentPath: '/project/src',
                                    gitRepoLink: undefined,
                                    paneLeft: '0',
                                    paneTop: '0'
                                },
                                {
                                    currentCommand: 'bash',
                                    currentPath: '/project',
                                    gitRepoLink: undefined,
                                    paneLeft: '1',
                                    paneTop: '0'
                                },
                                {
                                    currentCommand: 'nvim',
                                    currentPath: '/project/tests',
                                    gitRepoLink: undefined,
                                    paneLeft: '0',
                                    paneTop: '1'
                                }
                            ]
                        }
                    ]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(mixedSessions);
            mockGeneralUI.searchAndSelect.mockResolvedValue('mixed-save');

            await saveSessionsToFile();

            expect(mockNvim.saveNvimSession).toHaveBeenCalledTimes(2);
            expect(mockNvim.saveNvimSession).toHaveBeenCalledWith('mixed-save', 'mixed-session', 0, 0);
            expect(mockNvim.saveNvimSession).toHaveBeenCalledWith('mixed-save', 'mixed-session', 0, 2);
            expect(mockNvim.saveNvimSession).not.toHaveBeenCalledWith('mixed-save', 'mixed-session', 0, 1);
        });

        it('should handle empty search and select result', async () => {
            mockGeneralUI.searchAndSelect.mockResolvedValue('');

            await saveSessionsToFile();

            expect(mockFs.writeFile).toHaveBeenCalledWith(
                '/mock/session/files/',
                JSON.stringify(mockSessions, null, 2),
                'utf-8'
            );
        });

        it('should clean up stale nvim sessions', async () => {
            const sessionsWithMixedCommands: TmuxSessions = {
                'cleanup-session': {
                    windows: [
                        {
                            windowName: 'mixed',
                            layout: 'main-vertical',
                            currentCommand: 'bash',
                            currentPath: '/home',
                            gitRepoLink: undefined,
                            panes: [
                                {
                                    currentCommand: 'bash', // Should trigger cleanup
                                    currentPath: '/home',
                                    gitRepoLink: undefined,
                                    paneLeft: '0',
                                    paneTop: '0'
                                },
                                {
                                    currentCommand: 'nvim', // Should not trigger cleanup
                                    currentPath: '/home/project',
                                    gitRepoLink: undefined,
                                    paneLeft: '1',
                                    paneTop: '0'
                                }
                            ]
                        }
                    ]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(sessionsWithMixedCommands);
            mockGeneralUI.searchAndSelect.mockResolvedValue('cleanup-test');

            await saveSessionsToFile();

            // The cleanup happens asynchronously, so we need to wait a bit
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockFs.rm).toHaveBeenCalledWith('/mock/nvim/sessions/cleanup-session_0_0');
            expect(mockFs.rm).not.toHaveBeenCalledWith('/mock/nvim/sessions/cleanup-session_0_1');
        });
    });
});
