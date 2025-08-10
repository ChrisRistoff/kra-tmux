import { execSync } from 'child_process';
import {
    checkSessionExists,
    sourceTmuxConfig,
    killServer,
    updateCurrentSession
} from '@/tmux/utils/common';

import * as bash from '@/utils/bashHelper';
import * as lockFiles from '@/../eventSystem/lockFiles';
import * as ipc from '@/../eventSystem/ipc';
import * as utils from '@/utils/common';

jest.mock('child_process');
jest.mock('@/utils/bashHelper');
jest.mock('@/../eventSystem/lockFiles');
jest.mock('@/../eventSystem/ipc');
jest.mock('@/utils/common');

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockBash = bash as jest.Mocked<typeof bash>;
const mockLockFiles = lockFiles as jest.Mocked<typeof lockFiles>;
const mockIPC = ipc as jest.Mocked<typeof ipc>;
const mockUtils = utils as jest.Mocked<typeof utils>;

const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();

describe('tmux-session', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockLockFiles.createLockFile.mockResolvedValue(undefined);
        mockLockFiles.lockFileExist.mockResolvedValue(false);
        mockBash.execCommand.mockResolvedValue({ stdout: '', stderr: '' });
        mockUtils.sleep.mockResolvedValue(undefined);
        mockUtils.loadSettings.mockResolvedValue({
            watchCommands: {
                work: { active: false, watch: { windowName: '', command: '' } },
                personal: { active: false, watch: { windowName: '', command: '' } }
            },
            autosave: { active: true, currentSession: '', timeoutMs: 5000 }
        });
        mockUtils.saveSettings.mockResolvedValue(undefined);
    });

    afterAll(() => {
        mockConsoleLog.mockRestore();
    });

    describe('checkSessionExists', () => {
        it('should return true when session exists', () => {
            mockExecSync.mockReturnValue(Buffer.from(''));

            const result = checkSessionExists('my-session');

            expect(result).toBe(true);
            expect(mockExecSync).toHaveBeenCalledWith('tmux has-session -t my-session');
        });

        it('should return false when session does not exist', () => {
            const error = new Error("can't find session");
            mockExecSync.mockImplementation(() => {
                throw error;
            });

            const result = checkSessionExists('nonexistent-session');

            expect(result).toBe(false);
            expect(mockExecSync).toHaveBeenCalledWith('tmux has-session -t nonexistent-session');
        });

        it('should throw error for unexpected errors', () => {
            const unexpectedError = new Error('Connection refused');
            mockExecSync.mockImplementation(() => {
                throw unexpectedError;
            });

            expect(() => {
                checkSessionExists('test-session');
            }).toThrow('Unexpected error while checking session: Error: Connection refused');
        });

        it('should handle non-Error exceptions', () => {
            mockExecSync.mockImplementation(() => {
                throw 'string error';
            });

            expect(() => {
                checkSessionExists('test-session');
            }).toThrow('Unexpected error while checking session: string error');
        });
    });

    describe('sourceTmuxConfig', () => {
        it('should source tmux configuration and log success', async () => {
            await sourceTmuxConfig();

            expect(mockBash.execCommand).toHaveBeenCalledWith(
                expect.stringContaining('tmux source')
            );
            expect(mockBash.execCommand).toHaveBeenCalledWith(
                expect.stringContaining('.tmux.conf')
            );
            expect(mockConsoleLog).toHaveBeenCalledWith('Sourced tmux configuration file.');
        });

        it('should throw error if bash.execCommand fails', async () => {
            const error = new Error('Config file not found');
            mockBash.execCommand.mockRejectedValue(error);

            await expect(sourceTmuxConfig()).rejects.toThrow('Config file not found');
            expect(mockConsoleLog).not.toHaveBeenCalled();
        });
    });

    describe('killServer', () => {
        it('should kill server when no autosave is in progress', async () => {
            mockLockFiles.lockFileExist.mockResolvedValue(false);

            await killServer();

            expect(mockLockFiles.createLockFile).toHaveBeenCalledWith(mockLockFiles.LockFiles.ServerKillInProgress);
            expect(mockBash.execCommand).toHaveBeenCalledWith('tmux kill-server');
            expect(mockConsoleLog).not.toHaveBeenCalledWith('No Server Running');
        });

        it('should wait for autosave to complete before killing server', async () => {
            const mockClient = {
                emit: jest.fn().mockResolvedValue(undefined),
                ensureServerRunning: jest.fn().mockResolvedValue(undefined)
            };
            mockIPC.createIPCClient.mockReturnValue(mockClient);

            // autosave in progress, autosave complete
            mockLockFiles.lockFileExist
                .mockResolvedValueOnce(true)  // autosave in progress
                .mockResolvedValueOnce(true)  // while loop iteration - still in progress
                .mockResolvedValueOnce(false); // while loop iteration - complete

            await killServer();

            expect(mockLockFiles.createLockFile).toHaveBeenCalledWith(mockLockFiles.LockFiles.ServerKillInProgress);
            expect(mockIPC.createIPCClient).toHaveBeenCalledWith(mockIPC.IPCsockets.AutosaveSocket);
            expect(mockClient.emit).toHaveBeenCalledWith(mockIPC.IPCEvents.FlushAutosave);
            expect(mockConsoleLog).toHaveBeenCalledWith('Autosaving completing before exit');
            expect(mockUtils.sleep).toHaveBeenCalledWith(500);
            expect(mockBash.execCommand).toHaveBeenCalledWith('tmux kill-server');
        });

        it('should handle case where no server is running', async () => {
            mockLockFiles.lockFileExist.mockResolvedValue(false);
            mockBash.execCommand.mockRejectedValue(new Error('No server running'));

            await killServer();

            expect(mockConsoleLog).toHaveBeenCalledWith('No Server Running');
        });

        it('should continue checking autosave status multiple times', async () => {
            const mockClient = {
                emit: jest.fn().mockResolvedValue(undefined),
                ensureServerRunning: jest.fn().mockResolvedValue(undefined)
            };
            mockIPC.createIPCClient.mockReturnValue(mockClient);

            // autosave taking multiple cycles to complete
            mockLockFiles.lockFileExist
                .mockResolvedValueOnce(true)   // initial check
                .mockResolvedValueOnce(true)   // while iteration
                .mockResolvedValueOnce(true)   // while iteration
                .mockResolvedValueOnce(true)   // while iteration
                .mockResolvedValueOnce(false); // complete

            await killServer();

            expect(mockUtils.sleep).toHaveBeenCalledTimes(3);
            expect(mockConsoleLog).toHaveBeenCalledTimes(3);
            expect(mockConsoleLog).toHaveBeenNthCalledWith(1, 'Autosaving completing before exit');
            expect(mockConsoleLog).toHaveBeenNthCalledWith(2, 'Autosaving completing before exit');
            expect(mockConsoleLog).toHaveBeenNthCalledWith(3, 'Autosaving completing before exit');
        });
    });

    describe('updateCurrentSession', () => {
        it('should update current session in settings', async () => {
            const mockSettings = {
                watchCommands: {
                    work: { active: false, watch: { windowName: 'work-window', command: 'npm start' } },
                    personal: { active: true, watch: { windowName: 'personal-window', command: 'vim' } }
                },
                autosave: { active: true, currentSession: 'old-session', timeoutMs: 5000 }
            };
            mockUtils.loadSettings.mockResolvedValue(mockSettings);

            await updateCurrentSession('new-session');

            expect(mockUtils.loadSettings).toHaveBeenCalledTimes(1);
            expect(mockUtils.saveSettings).toHaveBeenCalledWith({
                watchCommands: {
                    work: { active: false, watch: { windowName: 'work-window', command: 'npm start' } },
                    personal: { active: true, watch: { windowName: 'personal-window', command: 'vim' } }
                },
                autosave: { active: true, currentSession: 'new-session', timeoutMs: 5000 }
            });
        });

        it('should handle settings loading failure', async () => {
            const error = new Error('Settings file not found');
            mockUtils.loadSettings.mockRejectedValue(error);

            await expect(updateCurrentSession('test-session')).rejects.toThrow('Settings file not found');
            expect(mockUtils.saveSettings).not.toHaveBeenCalled();
        });

        it('should handle settings saving failure', async () => {
            const mockSettings = {
                watchCommands: {
                    work: { active: false, watch: { windowName: '', command: '' } },
                    personal: { active: false, watch: { windowName: '', command: '' } }
                },
                autosave: { active: true, currentSession: 'old', timeoutMs: 3000 }
            };
            mockUtils.loadSettings.mockResolvedValue(mockSettings);
            mockUtils.saveSettings.mockRejectedValue(new Error('Disk full'));

            await expect(updateCurrentSession('new-session')).rejects.toThrow('Disk full');
        });
    });
});
