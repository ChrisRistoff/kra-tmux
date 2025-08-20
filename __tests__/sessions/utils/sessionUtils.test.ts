import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import { sessionFilesFolder } from '@/filePaths';
import { TmuxSessions, Window, Pane } from '@/types/sessionTypes';
import { formatWindow, formatPane } from '@/tmux/utils/formatters';
import { filterGitKeep } from '@/utils/common';
import {
    getCurrentSessions,
    getWindowsForSession,
    getPanesForWindow,
    getSavedSessionsNames,
    getSavedSessionsByFilePath,
    getDateString
} from '@/tmux/utils/sessionUtils';

jest.mock('fs/promises');
jest.mock('@/utils/bashHelper');
jest.mock('@/filePaths');
jest.mock('@/tmux/utils/formatters');
jest.mock('@/utils/common');

interface ExecResult {
    stdout: string | Buffer;
    stderr: string | Buffer;
    code: number;
}

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedBash = bash as jest.Mocked<typeof bash & { execCommand: jest.MockedFunction<(...args: any[]) => Promise<ExecResult>> }>;
const mockedFormatWindow = formatWindow as jest.MockedFunction<typeof formatWindow>;
const mockedFormatPane = formatPane as jest.MockedFunction<typeof formatPane>;
const mockedFilterGitKeep = filterGitKeep as jest.MockedFunction<typeof filterGitKeep>;

(sessionFilesFolder as any) = '/mock/sessions/path';

describe('Tmux Session Management', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getCurrentSessions', () => {
        it('should return current tmux sessions with windows', async () => {
            // Mock bash command output
            mockedBash.execCommand.mockResolvedValueOnce({
                stdout: 'session1\nsession2' as any,
                stderr: '' as any,
                code: 0
            });

            // Mock getWindowsForSession calls (indirectly through bash commands)
            mockedBash.execCommand
                .mockResolvedValueOnce({
                    stdout: 'window1:bash:/home/user:layout1' as any,
                    stderr: '' as any,
                    code: 0
                })
                .mockResolvedValueOnce({
                    stdout: '1234:/home/user:0x0' as any,
                    stderr: '' as any,
                    code: 0
                })
                .mockResolvedValueOnce({
                    stdout: 'window1:zsh:/home/user:layout1' as any,
                    stderr: '' as any,
                    code: 0
                })
                .mockResolvedValueOnce({
                    stdout: '5678:/home/user:0x0' as any,
                    stderr: '' as any,
                    code: 0
                });

            const mockWindow1: Window = {
                windowName: 'window1',
                currentCommand: 'bash',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                layout: 'layout1',
                panes: []
            };

            const mockWindow2: Window = {
                windowName: 'window1',
                currentCommand: 'zsh',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                layout: 'layout1',
                panes: []
            };

            const mockPane1: Pane = {
                currentCommand: 'bash',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };

            const mockPane2: Pane = {
                currentCommand: 'zsh',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };

            mockedFormatWindow.mockResolvedValueOnce(mockWindow1);
            mockedFormatWindow.mockResolvedValueOnce(mockWindow2);
            mockedFormatPane.mockResolvedValueOnce(mockPane1);
            mockedFormatPane.mockResolvedValueOnce(mockPane2);

            const result = await getCurrentSessions();

            expect(result).toEqual({
                session1: {
                    windows: [{ ...mockWindow1, panes: [mockPane1] }]
                },
                session2: {
                    windows: [{ ...mockWindow2, panes: [mockPane2] }]
                }
            });

            expect(mockedBash.execCommand).toHaveBeenCalledWith(`tmux list-sessions -F '#S'`);
        });

        it('should return empty object when tmux command fails', async () => {
            mockedBash.execCommand.mockRejectedValueOnce(new Error('tmux not running'));

            const result = await getCurrentSessions();

            expect(result).toEqual({});
        });

        it('should handle empty session list', async () => {
            // stdout is empty string, split('\n') creates ['']
            mockedBash.execCommand
                .mockResolvedValueOnce({
                    stdout: '' as any,
                    stderr: '' as any,
                    code: 0
                })

                // call to list-windows for the empty string session
                .mockResolvedValueOnce({
                    stdout: '' as any,
                    stderr: '' as any,
                    code: 0
                })

                // getPanesForWindow call that happens even when formatWindow returns undefined
                .mockResolvedValueOnce({
                    stdout: '' as any,
                    stderr: '' as any,
                    code: 0
                });

            // formatWindow to return a valid window object even for empty input
            // because code tries to set panes property
            const emptyWindow: Window = {
                windowName: '',
                currentCommand: '',
                currentPath: '',
                gitRepoLink: undefined,
                layout: '',
                panes: []
            };

            mockedFormatWindow.mockResolvedValueOnce(emptyWindow);
            mockedFormatPane.mockResolvedValue({
                currentCommand: '',
                currentPath: '',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            });

            const result = await getCurrentSessions();

            // result will have an empty string key with the empty window
            expect(result).toEqual({
                '': { windows: [emptyWindow] }
            });
        });

        it('should handle truly no sessions', async () => {
            // tmux has no sessions at all
            mockedBash.execCommand.mockRejectedValueOnce(new Error('no sessions'));

            const result = await getCurrentSessions();

            expect(result).toEqual({});
        });
    });

    describe('getWindowsForSession', () => {
        it('should return formatted windows with panes for a session', async () => {
            mockedBash.execCommand
                .mockResolvedValueOnce({
                    stdout: 'window1:vim:/home/user:layout1\nwindow2:bash:/tmp:layout2' as any,
                    stderr: '' as any,
                    code: 0
                })
                .mockResolvedValueOnce({
                    stdout: '1111:/home/user:0x0' as any,
                    stderr: '' as any,
                    code: 0
                })
                .mockResolvedValueOnce({
                    stdout: '2222:/tmp:0x0' as any,
                    stderr: '' as any,
                    code: 0
                });

            const mockWindow1: Window = {
                windowName: 'window1',
                currentCommand: 'vim',
                currentPath: '/home/user',
                gitRepoLink: 'https://github.com/user/repo',
                layout: 'layout1',
                panes: []
            };

            const mockWindow2: Window = {
                windowName: 'window2',
                currentCommand: 'bash',
                currentPath: '/tmp',
                gitRepoLink: undefined,
                layout: 'layout2',
                panes: []
            };

            const mockPane1: Pane = {
                currentCommand: 'vim',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };
            const mockPane2: Pane = {
                currentCommand: 'bash',
                currentPath: '/tmp',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };

            mockedFormatWindow.mockResolvedValueOnce(mockWindow1);
            mockedFormatWindow.mockResolvedValueOnce(mockWindow2);
            mockedFormatPane.mockResolvedValueOnce(mockPane1);
            mockedFormatPane.mockResolvedValueOnce(mockPane2);

            const result = await getWindowsForSession('test-session');

            expect(result).toEqual([
                { ...mockWindow1, panes: [mockPane1] },
                { ...mockWindow2, panes: [mockPane2] }
            ]);

            expect(mockedBash.execCommand).toHaveBeenCalledWith(
                `tmux list-windows -t test-session -F "#{window_name}:#{pane_current_command}:#{pane_current_path}:#{window_layout}"`
            );
        });

        it('should handle empty windows output', async () => {
            // windows stdout is empty string, split('\n') creates ['']
            mockedBash.execCommand
                .mockResolvedValueOnce({
                    stdout: '' as any,
                    stderr: '' as any,
                    code: 0
                })

                // getPanesForWindow call for empty window
                .mockResolvedValueOnce({
                    stdout: '' as any,
                    stderr: '' as any,
                    code: 0
                });

            // formatWindow to return a valid window object
            // code try to set panes property
            const emptyWindow: Window = {
                windowName: '',
                currentCommand: '',
                currentPath: '',
                gitRepoLink: undefined,
                layout: '',
                panes: []
            };

            mockedFormatWindow.mockResolvedValueOnce(emptyWindow);
            mockedFormatPane.mockResolvedValue({
                currentCommand: '',
                currentPath: '',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            });

            const result = await getWindowsForSession('empty-session');

            expect(result).toEqual([emptyWindow]);
        });
    });

    describe('getPanesForWindow', () => {
        it('should return formatted panes for a window', async () => {
            mockedBash.execCommand.mockResolvedValueOnce({
                stdout: '1234:/home/user:0x0\n5678:/tmp:10x5' as any,
                stderr: '' as any,
                code: 0
            });

            const mockPane1: Pane = {
                currentCommand: 'bash',
                currentPath: '/home/user',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };
            const mockPane2: Pane = {
                currentCommand: 'vim',
                currentPath: '/tmp',
                gitRepoLink: undefined,
                paneLeft: '10',
                paneTop: '5'
            };

            mockedFormatPane.mockResolvedValueOnce(mockPane1);
            mockedFormatPane.mockResolvedValueOnce(mockPane2);

            const result = await getPanesForWindow('test-session', 0);

            expect(result).toEqual([mockPane1, mockPane2]);

            expect(mockedBash.execCommand).toHaveBeenCalledWith(
                `tmux list-panes -t test-session:0 -F "#{pane_pid}:#{pane_current_path}:#{pane_left}x#{pane_top}"`
            );
        });

        it('should return empty array when pane command fails', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            mockedBash.execCommand.mockRejectedValueOnce(new Error('No such window'));

            const result = await getPanesForWindow('test-session', 99);

            expect(result).toEqual([]);
            expect(consoleSpy).toHaveBeenCalledWith('Error getting panes:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe('getSavedSessionsNames', () => {
        it('should return filtered session names', async () => {
            const mockFiles = ['session1.json', 'session2.json', '.gitkeep'];
            const filteredFiles = ['session1.json', 'session2.json'];

            mockedFs.readdir.mockResolvedValueOnce(mockFiles as any);
            mockedFilterGitKeep.mockReturnValueOnce(filteredFiles);

            const result = await getSavedSessionsNames();

            expect(result).toEqual(filteredFiles);
            expect(mockedFs.readdir).toHaveBeenCalledWith(sessionFilesFolder);
            expect(mockedFilterGitKeep).toHaveBeenCalledWith(mockFiles);
        });

        it('should return empty array when directory read fails', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockedFs.readdir.mockRejectedValueOnce(new Error('Directory not found'));

            const result = await getSavedSessionsNames();

            expect(result).toEqual([]);
            expect(consoleSpy).toHaveBeenCalledWith('Error reading directory:', expect.any(Error));

            consoleSpy.mockRestore();
        });
    });

    describe('getSavedSessionsByFilePath', () => {
        it('should parse and return sessions from file', async () => {
            const mockSessionData: TmuxSessions = {
                'saved-session': {
                    windows: [
                        {
                            windowName: 'main',
                            currentCommand: 'bash',
                            currentPath: '/home/user',
                            gitRepoLink: 'https://github.com/user/project',
                            layout: 'even-horizontal',
                            panes: []
                        }
                    ]
                }
            };

            mockedFs.readFile.mockResolvedValueOnce(Buffer.from(JSON.stringify(mockSessionData)));

            const result = await getSavedSessionsByFilePath('/path/to/session.json');

            expect(result).toEqual(mockSessionData);
            expect(mockedFs.readFile).toHaveBeenCalledWith('/path/to/session.json');
        });

        it('should throw error for invalid JSON', async () => {
            mockedFs.readFile.mockResolvedValueOnce(Buffer.from('invalid json'));

            await expect(getSavedSessionsByFilePath('/path/to/invalid.json'))
                .rejects.toThrow();
        });

        it('should throw error when file read fails', async () => {
            mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));

            await expect(getSavedSessionsByFilePath('/path/to/missing.json'))
                .rejects.toThrow('File not found');
        });
    });

    describe('getDateString', () => {
        beforeEach(() => {
            // Date to return consistent results
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should format current date correctly', () => {
            // specific date for testing
            const mockDate = new Date('2023-08-25T14:30:45.123Z');
            jest.setSystemTime(mockDate);

            const result = getDateString();

            // test assumes the date toString format, adjust as needed
            expect(result).toMatch(/^\d{4}-\w{3}-\d{2}-\d{2}:\d{2}$/);
        });

        it('should handle different times consistently', () => {
            const mockDate1 = new Date('2023-12-31T23:59:59.999Z');
            jest.setSystemTime(mockDate1);
            const result1 = getDateString();

            const mockDate2 = new Date('2024-01-01T00:00:00.000Z');
            jest.setSystemTime(mockDate2);
            const result2 = getDateString();

            expect(result1).not.toBe(result2);
            expect(result1).toMatch(/^\d{4}-\w{3}-\d{2}-\d{2}:\d{2}$/);
            expect(result2).toMatch(/^\d{4}-\w{3}-\d{2}-\d{2}:\d{2}$/);
        });
    });

    describe('Integration scenarios', () => {
        it('should handle a complete session lifecycle', async () => {
            // current sessions
            mockedBash.execCommand
                .mockResolvedValueOnce({
                    stdout: 'dev-session' as any,
                    stderr: '' as any,
                    code: 0
                })

                .mockResolvedValueOnce({
                    stdout: 'editor:nvim:/project:main-vertical' as any,
                    stderr: '' as any,
                    code: 0
                })

                .mockResolvedValueOnce({
                    stdout: '9999:/project:0x0' as any,
                    stderr: '' as any,
                    code: 0
                });

            const mockWindow: Window = {
                windowName: 'editor',
                currentCommand: 'nvim',
                currentPath: '/project',
                gitRepoLink: 'https://github.com/user/project',
                layout: 'main-vertical',
                panes: []
            };

            const mockPane: Pane = {
                currentCommand: 'nvim',
                currentPath: '/project',
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: '0'
            };

            mockedFormatWindow.mockResolvedValueOnce(mockWindow);
            mockedFormatPane.mockResolvedValueOnce(mockPane);

            const sessions = await getCurrentSessions();

            expect(sessions).toEqual({
                'dev-session': {
                    windows: [{ ...mockWindow, panes: [mockPane] }]
                }
            });

            expect(mockedBash.execCommand).toHaveBeenCalledTimes(3);
            expect(mockedFormatWindow).toHaveBeenCalledTimes(1);
            expect(mockedFormatPane).toHaveBeenCalledTimes(1);
        });
    });
});

describe('Tmux Session Management - Edge Cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should handle malformed tmux output gracefully', async () => {
        mockedBash.execCommand
            .mockResolvedValueOnce({
                stdout: 'malformed:output:without:proper:format' as any,
                stderr: '' as any,
                code: 0
            })

            // getPanesForWindow
            .mockResolvedValueOnce({
                stdout: '' as any,
                stderr: '' as any,
                code: 0
            });

        // formatWindow to return a valid window object
        const mockWindow: Window = {
            windowName: 'unknown',
            currentCommand: 'unknown',
            currentPath: '/unknown',
            gitRepoLink: undefined,
            layout: 'unknown',
            panes: []
        };

        mockedFormatWindow.mockResolvedValueOnce(mockWindow);
        mockedFormatPane.mockResolvedValue({
            currentCommand: 'unknown',
            currentPath: '/unknown',
            gitRepoLink: undefined,
            paneLeft: '0',
            paneTop: '0'
        });

        const result = await getWindowsForSession('test');
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        expect(result[0]).toEqual(mockWindow);
    });

    it('should handle concurrent session access', async () => {
        // concurrent operations, need to mock multiple sequential calls
        mockedBash.execCommand
            // getCurrentSessions call
            .mockResolvedValueOnce({
                stdout: 'session1' as any,
                stderr: '' as any,
                code: 0
            })

            .mockResolvedValueOnce({
                stdout: 'window1:bash:/tmp:even' as any,
                stderr: '' as any,
                code: 0
            })

            .mockResolvedValueOnce({
                stdout: '1234:/tmp:0x0' as any,
                stderr: '' as any,
                code: 0
            })

            // 2nd getCurrentSessions call
            .mockResolvedValueOnce({
                stdout: 'session1' as any,
                stderr: '' as any,
                code: 0
            })

            .mockResolvedValueOnce({
                stdout: 'window1:bash:/tmp:even' as any,
                stderr: '' as any,
                code: 0
            })

            .mockResolvedValueOnce({
                stdout: '1234:/tmp:0x0' as any,
                stderr: '' as any,
                code: 0
            })

            // getWindowsForSession call
            .mockResolvedValueOnce({
                stdout: 'window1:bash:/tmp:even' as any,
                stderr: '' as any,
                code: 0
            })

            .mockResolvedValueOnce({
                stdout: '1234:/tmp:0x0' as any,
                stderr: '' as any,
                code: 0
            });

        const mockWindow = {
            windowName: 'test',
            currentCommand: 'bash',
            currentPath: '/tmp',
            gitRepoLink: undefined,
            layout: 'even',
            panes: []
        };

        const mockPane = {
            currentCommand: 'bash',
            currentPath: '/tmp',
            gitRepoLink: undefined,
            paneLeft: '0',
            paneTop: '0'
        };

        mockedFormatWindow.mockResolvedValue(mockWindow);
        mockedFormatPane.mockResolvedValue(mockPane);

        // multiple concurrent operations
        const promises = [
            getCurrentSessions(),
            getCurrentSessions(),
            getWindowsForSession('session1')
        ];

        const results = await Promise.all(promises);

        expect(results).toHaveLength(3);
        results.forEach((result: any) => {
            expect(result).toBeDefined();
        });
    });
});
