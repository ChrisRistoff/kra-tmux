import * as fs from 'fs/promises';
import * as utils from '@/utils/common';
import * as generalUI from '@/UI/generalUI';
import { getCurrentSessions, getSavedSessionsNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/utils/common';
import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import { createLockFile, LockFiles } from '@/../eventSystem/lockFiles';
import * as bash from '@/utils/bashHelper';
import { loadSession, getSessionsFromSaved, handleSessionsIfServerIsRunning } from '@/tmux/commands/loadSession';
import { TmuxSessions } from '@/types/sessionTypes';

jest.mock('fs/promises');
jest.mock('@/utils/common');
jest.mock('@/UI/generalUI');
jest.mock('@/tmux/utils/sessionUtils');
jest.mock('@/tmux/commands/printSessions');
jest.mock('@/tmux/utils/common');
jest.mock('@/tmux/commands/saveSessions');
jest.mock('@/../eventSystem/lockFiles');
jest.mock('@/utils/bashHelper');
jest.mock('@/filePaths', () => ({
    nvimSessionsPath: '/mock/nvim/sessions',
    sessionFilesFolder: '/mock/session/files'
}));

describe('loadSession', () => {
    const mockFs = jest.mocked(fs);
    const mockUtils = jest.mocked(utils);
    const mockGeneralUI = jest.mocked(generalUI);
    const mockGetSavedSessionsNames = jest.mocked(getSavedSessionsNames);
    const mockGetCurrentSessions = jest.mocked(getCurrentSessions);
    const mockPrintSessions = jest.mocked(printSessions);
    const mockTmux = jest.mocked(tmux);
    const mockSaveSessionsToFile = jest.mocked(saveSessionsToFile);
    const mockCreateLockFile = jest.mocked(createLockFile);
    const mockBash = jest.mocked(bash);

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.SHELL = '/bin/zsh';

        mockCreateLockFile.mockResolvedValue();
        mockTmux.sourceTmuxConfig.mockResolvedValue();
        mockTmux.updateCurrentSession.mockImplementation(() => new Promise(() => { }));
        mockTmux.killServer.mockResolvedValue();
        mockUtils.sleep.mockResolvedValue();
        mockSaveSessionsToFile.mockResolvedValue();
        mockPrintSessions.mockImplementation(() => { });
        mockFs.rm.mockResolvedValue();
    });

    describe('loadSession', () => {
        it('should successfully load a session', async () => {
            const mockSessionNames = ['server1', 'server2'];
            const mockSavedData: TmuxSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'main',
                            layout: 'main-vertical',
                            currentCommand: 'vim',
                            currentPath: '/home/user/project',
                            gitRepoLink: 'git@github.com:user/repo.git',
                            panes: [
                                {
                                    currentCommand: 'vim',
                                    currentPath: '/home/user/project',
                                    gitRepoLink: 'git@github.com:user/repo.git',
                                    paneLeft: '0',
                                    paneTop: '0'
                                }
                            ]
                        }
                    ]
                }
            };

            mockGetSavedSessionsNames.mockResolvedValue(mockSessionNames);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue('server1');
            mockFs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(mockSavedData)));

            // session creation
            mockBash.execCommand
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // kill existing session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create new session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verify session exists
                .mockResolvedValueOnce({ stdout: '0:main\n', stderr: '' }) // list windows
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create script file
                .mockResolvedValueOnce({ stdout: '', stderr: '' }); // execute script

            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await loadSession();

            expect(mockCreateLockFile).toHaveBeenCalledWith(LockFiles.LoadInProgress);
            expect(mockGetSavedSessionsNames).toHaveBeenCalled();
            expect(mockGeneralUI.searchSelectAndReturnFromArray).toHaveBeenCalledWith({
                itemsArray: mockSessionNames,
                prompt: "Select a session to load from the list:",
            });
            expect(mockFs.readFile).toHaveBeenCalledWith('/mock/session/files/server1');
            expect(mockTmux.sourceTmuxConfig).toHaveBeenCalled();
            expect(mockTmux.updateCurrentSession).toHaveBeenCalledWith('server1');
            expect(consoleSpy).toHaveBeenCalledWith('Sessions loaded successfully');

            consoleSpy.mockRestore();
        });

        it('should handle error when no saved sessions found', async () => {
            const mockSessionNames = ['server1'];

            mockGetSavedSessionsNames.mockResolvedValue(mockSessionNames);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue('server1');
            mockFs.readFile.mockResolvedValue(Buffer.from('null'));

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await loadSession();

            expect(consoleSpy).toHaveBeenCalledWith('No saved sessions found.');
            consoleSpy.mockRestore();
        });

        it('should handle errors during session loading', async () => {
            mockGetSavedSessionsNames.mockRejectedValue(new Error('Failed to get sessions'));

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await loadSession();

            expect(consoleSpy).toHaveBeenCalledWith('Load session error:', expect.any(Error));
            consoleSpy.mockRestore();
        });
    });

    describe('getSessionsFromSaved', () => {
        it('should successfully read and parse session data', async () => {
            const mockData: TmuxSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'editor',
                            layout: 'main-horizontal',
                            currentCommand: 'nvim',
                            currentPath: '/workspace',
                            gitRepoLink: undefined,
                            panes: []
                        }
                    ]
                }
            };

            mockFs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(mockData)));

            const result = await getSessionsFromSaved('test-server');

            expect(mockFs.readFile).toHaveBeenCalledWith('/mock/session/files/test-server');
            expect(result).toEqual(mockData);
        });

        it('should handle file read errors', async () => {
            mockFs.readFile.mockRejectedValue(new Error('File not found'));

            await expect(getSessionsFromSaved('nonexistent')).rejects.toThrow('File not found');
        });

        it('should handle JSON parse errors', async () => {
            mockFs.readFile.mockResolvedValue(Buffer.from('invalid json'));

            await expect(getSessionsFromSaved('corrupt-file')).rejects.toThrow();
        });
    });

    describe('handleSessionsIfServerIsRunning', () => {
        it('should handle server with existing sessions and save them', async () => {
            const mockCurrentSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'main',
                            layout: 'tiled',
                            currentCommand: 'bash',
                            currentPath: '/home',
                            gitRepoLink: undefined,
                            panes: []
                        }
                    ]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(mockCurrentSessions);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(true);

            await handleSessionsIfServerIsRunning();

            expect(mockPrintSessions).toHaveBeenCalledWith(mockCurrentSessions);
            expect(mockGeneralUI.promptUserYesOrNo).toHaveBeenCalledWith(
                'Would you like to save currently running sessions?'
            );
            expect(mockSaveSessionsToFile).toHaveBeenCalled();
            expect(mockTmux.killServer).toHaveBeenCalled();
            expect(mockUtils.sleep).toHaveBeenCalledWith(200);
        });

        it('should handle server with existing sessions and not save them', async () => {
            const mockCurrentSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'temp',
                            layout: '15x15x15',
                            currentCommand: 'top',
                            currentPath: '/tmp',
                            gitRepoLink: undefined,
                            panes: []
                        }
                    ]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(mockCurrentSessions);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(false);

            await handleSessionsIfServerIsRunning();

            expect(mockPrintSessions).toHaveBeenCalledWith(mockCurrentSessions);
            expect(mockGeneralUI.promptUserYesOrNo).toHaveBeenCalledWith(
                'Would you like to save currently running sessions?'
            );
            expect(mockSaveSessionsToFile).not.toHaveBeenCalled();
            expect(mockTmux.killServer).toHaveBeenCalled();
            expect(mockUtils.sleep).toHaveBeenCalledWith(200);
        });

        it('should handle server with no existing sessions', async () => {
            mockGetCurrentSessions.mockResolvedValue({});

            await handleSessionsIfServerIsRunning();

            expect(mockPrintSessions).not.toHaveBeenCalled();
            expect(mockGeneralUI.promptUserYesOrNo).not.toHaveBeenCalled();
            expect(mockSaveSessionsToFile).not.toHaveBeenCalled();
            expect(mockTmux.killServer).not.toHaveBeenCalled();
            expect(mockUtils.sleep).not.toHaveBeenCalled();
        });
    });

    describe('session creation and script generation', () => {
        it('should handle session creation failure', async () => {
            const mockSessionNames = ['server1'];
            const mockSavedData: TmuxSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'main',
                            layout: 'main-vertical',
                            currentCommand: 'bash',
                            currentPath: '/home/user',
                            gitRepoLink: undefined,
                            panes: [
                                {
                                    currentCommand: 'bash',
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

            mockGetSavedSessionsNames.mockResolvedValue(mockSessionNames);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue('server1');
            mockFs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(mockSavedData)));

            // session creation failure
            mockBash.execCommand
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // kill existing session
                .mockRejectedValueOnce(new Error('Failed to create session')); // create session fails

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await loadSession();

            expect(consoleSpy).toHaveBeenCalledWith('Failed to create session session1:', expect.any(Error));

            consoleSpy.mockRestore();
        });

        it('should handle windows with multiple panes and nvim commands', async () => {
            const mockSessionNames = ['server1'];
            const mockSavedData: TmuxSessions = {
                session1: {
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
                            currentCommand: 'htop',
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

            mockGetSavedSessionsNames.mockResolvedValue(mockSessionNames);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue('server1');
            mockFs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(mockSavedData)));

            // successful session creation
            mockBash.execCommand
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // kill existing session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create new session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verify session exists
                .mockResolvedValueOnce({ stdout: '0:editor\n', stderr: '' }) // list windows
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create script file
                .mockResolvedValueOnce({ stdout: '', stderr: '' }); // execute script

            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await loadSession();

            expect(consoleSpy).toHaveBeenCalledWith('Sessions loaded successfully');

            consoleSpy.mockRestore();
        });

        it('should handle script execution failure', async () => {
            const mockSessionNames = ['server1'];
            const mockSavedData: TmuxSessions = {
                session1: {
                    windows: [
                        {
                            windowName: 'main',
                            layout: '15x15x15',
                            currentCommand: 'bash',
                            currentPath: '/home/user',
                            gitRepoLink: undefined,
                            panes: [
                                {
                                    currentCommand: 'bash',
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

            mockGetSavedSessionsNames.mockResolvedValue(mockSessionNames);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue('server1');
            mockFs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(mockSavedData)));

            // successful session creation but script execution failure
            mockBash.execCommand
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // kill existing session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create new session
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verify session exists
                .mockResolvedValueOnce({ stdout: '0:main\n', stderr: '' }) // list windows
                .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create script file
                .mockRejectedValueOnce(new Error('Script execution failed')); // execute script fails

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await loadSession();

            expect(consoleSpy).toHaveBeenCalledWith('Load session error:', expect.any(Error));
            expect(mockFs.rm).toHaveBeenCalled(); // should still clean up

            consoleSpy.mockRestore();
        });
    });
});
