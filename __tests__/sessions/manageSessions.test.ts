import { deleteSession } from '@/tmux/commands/manageSessions';
import { getSavedSessionsNames, getSavedSessionsByFilePath } from '@/tmux/utils/sessionUtils';
import * as fs from 'fs/promises';
import * as generalUI from '@/UI/generalUI';
import { TmuxSessions } from '@/types/sessionTypes';
import { sessionFilesFolder } from '@/filePaths';

jest.mock('@/tmux/utils/sessionUtils');
jest.mock('fs/promises');
jest.mock('@/UI/generalUI');

describe('Session Management', () => {
    const mockGetSavedSessionsNames = jest.mocked(getSavedSessionsNames);
    const mockGetSavedSessionsByFilePath = jest.mocked(getSavedSessionsByFilePath);
    const mockFsRm = jest.mocked(fs.rm);
    const mockGeneralUI = jest.mocked(generalUI);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('deleteSession', () => {
        it('should delete a session file when confirmed', async () => {
            const testFileName = 'test-session';
            const testSessions = {
                [testFileName]: {
                    windows: [{ windowName: 'test-window', panes: [], layout: '', currentPath: '' }]
                }
            } as unknown as TmuxSessions;

            mockGetSavedSessionsNames.mockResolvedValue([testFileName]);
            mockGetSavedSessionsByFilePath.mockResolvedValue(testSessions);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(testFileName);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(true);

            await deleteSession();

            expect(mockFsRm).toHaveBeenCalledWith(`${sessionFilesFolder}/${testFileName}`);
        });

        it('should not delete session when not confirmed', async () => {
            const testFileName = 'test-session';
            const testSessions = {
                [testFileName]: {
                    windows: [{ windowName: 'test-window', panes: [], layout: '', currentPath: '' }]
                }
            } as unknown as TmuxSessions;

            mockGetSavedSessionsNames.mockResolvedValue([testFileName]);
            mockGetSavedSessionsByFilePath.mockResolvedValue(testSessions);
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(testFileName);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(false);

            await deleteSession();

            expect(mockFsRm).not.toHaveBeenCalled();
        });
    });
});
