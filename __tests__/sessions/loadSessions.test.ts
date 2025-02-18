import { loadLatestSession, handleSessionsIfServerIsRunning } from '@sessions/commands/loadSession';
import * as sessionUtils from '@sessions/utils/sessionUtils';
import * as generalUI from '@UI/generalUI';
import * as fs from 'fs/promises';
import * as tmux from '@sessions/core/tmux';
import * as utils from '@utils/common';
import { saveSessionsToFile } from '@sessions/commands/saveSessions';

jest.mock('@sessions/utils/sessionUtils');
jest.mock('@UI/generalUI');
jest.mock('fs/promises');
jest.mock('@sessions/core/tmux');
jest.mock('@utils/common');
jest.mock('@utils/neovimHelper');
jest.mock('@sessions/commands/saveSessions');
jest.mock('@utils/bashHelper', () => ({
  sendKeysToTmuxTargetSession: jest.fn(() => Promise.resolve())
}));

beforeAll(() => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterAll(() => {
  (process.stdout.write as jest.Mock).mockRestore();
});

describe('loadLatestSession', () => {
    const mockGetSavedSessionsNames = jest.mocked(sessionUtils.getSavedSessionsNames);
    const mockGeneralUI = jest.mocked(generalUI);
    const mockFsReadFile = jest.mocked(fs.readFile);
    const mockTmux = jest.mocked(tmux);
    const mockUtils = jest.mocked(utils);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully load and attach a saved session', async () => {
        const testFileName = 'testSession.json';
        const sessionsData = {
            testSession: {
                windows: [
                    {
                        windowName: 'win1',
                        layout: 'even-horizontal',
                        panes: [
                            {
                                currentPath: '/home/user/project',
                                gitRepoLink: 'https://github.com/repo.git',
                                currentCommand: ''
                            }
                        ]
                    }
                ]
            }
        };

        mockGetSavedSessionsNames.mockResolvedValue([testFileName]);
        mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(testFileName);
        mockFsReadFile.mockResolvedValue(Buffer.from(JSON.stringify(sessionsData)));

        mockUtils.loadSettings.mockResolvedValue({
            work: false,
            workWindowNameForWatch: 'WORK',
            workCommandForWatch: 'work-watch',
            personalWindowNameForWatch: 'PERSONAL',
            personalCommandForWatch: 'personal-watch'
        });

        await loadLatestSession();

        expect(mockTmux.createSession).toHaveBeenCalledWith('testSession');
        expect(mockTmux.setLayout).toHaveBeenCalledWith(
            'testSession',
            0,
            sessionsData.testSession.windows[0].layout
        );
        expect(mockTmux.selectPane).toHaveBeenCalledWith('testSession', 0, 0);
        expect(mockTmux.selectWindow).toHaveBeenCalledWith(0);
        expect(mockTmux.renameWindow).toHaveBeenCalledWith(
            'testSession',
            0,
            sessionsData.testSession.windows[0].windowName
        );
        expect(mockTmux.sourceTmuxConfig).toHaveBeenCalled();
        expect(mockTmux.attachToSession).toHaveBeenCalledWith('testSession');
    });

    it('should log error and return if no file is selected', async () => {
        mockGetSavedSessionsNames.mockResolvedValue(['session.json']);
        mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(null!);

        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await loadLatestSession();

        expect(consoleErrorSpy).toHaveBeenCalledWith('No saved sessions found.');
        consoleErrorSpy.mockRestore();
    });
});

describe('handleSessionsIfServerIsRunning', () => {
    const mockGetCurrentSessions = jest.mocked(sessionUtils.getCurrentSessions);
    const mockPrintSessions = jest.fn();
    const mockPrompt = jest.mocked(generalUI.promptUserYesOrNo);
    const mockSaveSessionsToFile = jest.mocked(saveSessionsToFile);
    const mockTmux = jest.mocked(tmux);
    const mockUtils = jest.mocked(utils);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should save sessions, kill server and sleep when confirmed', async () => {
        const currentSessions = { session1: { windows: [] } };
        mockGetCurrentSessions.mockResolvedValue(currentSessions);
        jest.spyOn(require('@sessions/commands/printSessions'), 'printSessions').mockImplementation(mockPrintSessions);
        mockPrompt.mockResolvedValue(true);
        mockUtils.sleep.mockResolvedValue(undefined);

        await handleSessionsIfServerIsRunning();

        expect(mockPrintSessions).toHaveBeenCalledWith(currentSessions);
        expect(mockSaveSessionsToFile).toHaveBeenCalled();
        expect(mockTmux.killServer).toHaveBeenCalled();
        expect(mockUtils.sleep).toHaveBeenCalledWith(200);
    });

    it('should only kill server when not confirmed to save sessions', async () => {
        const currentSessions = { session1: { windows: [] } };
        mockGetCurrentSessions.mockResolvedValue(currentSessions);
        jest.spyOn(require('@sessions/commands/printSessions'), 'printSessions').mockImplementation(mockPrintSessions);
        mockPrompt.mockResolvedValue(false);
        mockUtils.sleep.mockResolvedValue(undefined);

        await handleSessionsIfServerIsRunning();

        expect(mockPrintSessions).toHaveBeenCalledWith(currentSessions);
        expect(mockSaveSessionsToFile).not.toHaveBeenCalled();
        expect(mockTmux.killServer).toHaveBeenCalled();
        expect(mockUtils.sleep).toHaveBeenCalledWith(200);
    });

    it('should do nothing if no sessions are running', async () => {
        mockGetCurrentSessions.mockResolvedValue({});

        await handleSessionsIfServerIsRunning();

        expect(mockPrintSessions).not.toHaveBeenCalled();
        expect(mockPrompt).not.toHaveBeenCalled();
        expect(mockSaveSessionsToFile).not.toHaveBeenCalled();
        expect(mockTmux.killServer).not.toHaveBeenCalled();
    });
});

