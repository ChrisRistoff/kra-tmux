import { printSessions, printCurrentSessions } from '@tmux/commands/printSessions';
import { getCurrentSessions } from '@tmux/utils/sessionUtils';
import { TmuxSessions } from '@/types/sessionTypes';

jest.mock('@tmux/utils/sessionUtils');

const mockConsoleTable = jest.fn();
global.console = {
    ...console,
    table: mockConsoleTable
} as unknown as Console;

describe('printSessions', () => {
    const mockGetCurrentSessions = jest.mocked(getCurrentSessions);
    const mockConsoleTable = jest.mocked(console.table);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('printSessions', () => {
        it('should print session information in table format', () => {
            const testSessions: TmuxSessions = {
                'session1': {
                    windows: [{
                        windowName: 'window1',
                        currentCommand: '',
                        layout: '',
                        currentPath: '/path1',
                        gitRepoLink: undefined,
                        panes: [
                            { currentCommand: '', currentPath: '', gitRepoLink: undefined, paneLeft: '0', paneTop: '0' }
                        ]
                    }]
                }
            };

            printSessions(testSessions);

            expect(mockConsoleTable).toHaveBeenCalledWith({
                Name: 'session1',
                Path: '/path1',
                Windows: 1,
                Panes: 1
            });
        });

        it('should handle multiple windows and panes', () => {
            const testSessions: TmuxSessions = {
                'session2': {
                    windows: [
                        {
                            windowName: 'window1',
                            currentCommand: '',
                            layout: '',
                            currentPath: '/path2',
                            gitRepoLink: undefined,
                            panes: [
                                { currentCommand: '', currentPath: '', gitRepoLink: undefined, paneLeft: '0', paneTop: '0' },
                                { currentCommand: '', currentPath: '', gitRepoLink: undefined, paneLeft: '0', paneTop: '0' }
                            ]
                        },
                        {
                            windowName: 'window2',
                            currentCommand: '',
                            layout: '',
                            currentPath: '/path3',
                            gitRepoLink: undefined,
                            panes: [
                                { currentCommand: '', currentPath: '', gitRepoLink: undefined, paneLeft: '0', paneTop: '0' }
                            ]
                        }
                    ]
                }
            };

            printSessions(testSessions);

            expect(mockConsoleTable).toHaveBeenCalledWith({
                Name: 'session2',
                Path: '/path2',
                Windows: 2,
                Panes: 3
            });
        });
    });

    describe('printCurrentSessions', () => {
        it('should get and print current sessions', async () => {
            const testSessions: TmuxSessions = {
                'session3': {
                    windows: [{
                        windowName: 'window1',
                        currentCommand: '',
                        layout: '',
                        currentPath: '/path4',
                        gitRepoLink: undefined,
                        panes: [
                            { currentCommand: '', currentPath: '', gitRepoLink: undefined, paneLeft: '0', paneTop: '0' }
                        ]
                    }]
                }
            };

            mockGetCurrentSessions.mockResolvedValue(testSessions);

            await printCurrentSessions();

            expect(mockGetCurrentSessions).toHaveBeenCalled();
            expect(mockConsoleTable).toHaveBeenCalledWith({
                Name: 'session3',
                Path: '/path4',
                Windows: 1,
                Panes: 1
            });
        });
    });
});
