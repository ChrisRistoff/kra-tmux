import { deleteSession } from '@sessions/commands/manageSessions';
import { getSavedSessionsNames, getSavedSessionsByFilePath } from '@sessions/utils/sessionUtils';
import { printSessions } from '@sessions/commands/printSessions';
import * as fs from 'fs/promises';
import * as generalUI from '@UI/generalUI';
import { TmuxSessions } from '@/types/sessionTypes';
import { sessionFilesFolder } from '@filePaths';

jest.mock('@sessions/utils/sessionUtils');
jest.mock('@sessions/commands/printSessions');
jest.mock('fs/promises');
jest.mock('@UI/generalUI');

describe('Session Management', () => {
    const mockGetSavedSessionsNames = jest.mocked(getSavedSessionsNames);
    const mockGetSavedSessionsByFilePath = jest.mocked(getSavedSessionsByFilePath);
    const mockPrintSessions = jest.mocked(printSessions);
    const mockFsRm = jest.mocked(fs.rm);
    const mockGeneralUI = jest.mocked(generalUI);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('deleteSession', () => {
        it('should delete a session file when confirmed', async () => {
            const testFileName = 'test-session';
            const testSessions = { [testFileName]: {} } as unknown as TmuxSessions;

            mockGetSavedSessionsNames.mockResolvedValue([testFileName]);
            mockGetSavedSessionsByFilePath.mockResolvedValue(testSessions);
            mockPrintSessions.mockImplementation(() => {});
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(testFileName);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(true);

            await deleteSession();

            expect(mockFsRm).toHaveBeenCalledWith(`${sessionFilesFolder}/${testFileName}`);
            expect(mockPrintSessions).toHaveBeenCalledWith(testSessions);
        });

        it('should not delete session when not confirmed', async () => {
            const testFileName = 'test-session';
            const testSessions = { [testFileName]: {} } as unknown as TmuxSessions;

            mockGetSavedSessionsNames.mockResolvedValue([testFileName]);
            mockGetSavedSessionsByFilePath.mockResolvedValue(testSessions);
            mockPrintSessions.mockImplementation(() => {});
            mockGeneralUI.searchSelectAndReturnFromArray.mockResolvedValue(testFileName);
            mockGeneralUI.promptUserYesOrNo.mockResolvedValue(false);

            await deleteSession();

            expect(mockFsRm).not.toHaveBeenCalled();
        });
    });
});
