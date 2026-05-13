import * as bash from '@/utils/bashHelper';
import * as generalUI from '@/UI/generalUI';
import { getCurrentSessions, getDateString } from '@/tmux/utils/sessionUtils';
import { TmuxSessions } from '@/types/sessionTypes';
import {
    listSavedNames,
    writeSavedFile,
    savedFileExists,
} from '@/tmux/utils/savedSessionsIO';
import { saveNvimForSessions } from '@/tmux/utils/nvimSaveSync';
import { saveSession } from '@/tmux/commands/saveSession';

jest.mock('@/utils/bashHelper');
jest.mock('@/UI/generalUI');
jest.mock('@/tmux/utils/sessionUtils');
jest.mock('@/tmux/utils/savedSessionsIO');
jest.mock('@/tmux/utils/nvimSaveSync');
jest.mock('@/filePaths', () => ({
    nvimSessionsPath: '/mock/nvim/sessions',
    serverFilesFolder: '/mock/session/files',
    singleSessionFilesFolder: '/mock/single/sessions',
}));

const mockBash = jest.mocked(bash);
const mockUI = jest.mocked(generalUI);
const mockGetCurrentSessions = jest.mocked(getCurrentSessions);
const mockGetDateString = jest.mocked(getDateString);
const mockListSavedNames = jest.mocked(listSavedNames);
const mockWriteSavedFile = jest.mocked(writeSavedFile);
const mockSavedFileExists = jest.mocked(savedFileExists);
const mockSaveNvim = jest.mocked(saveNvimForSessions);

const sampleSessions: TmuxSessions = {
    'alpha': { windows: [] },
    'beta': { windows: [] },
};

function bashOk(stdout: string): { stdout: string; stderr: string } {
    return { stdout, stderr: '' };
}

describe('saveSession', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetDateString.mockReturnValue('2024-Jan-01-1200');
        mockListSavedNames.mockResolvedValue([]);
        mockSavedFileExists.mockResolvedValue(false);
        mockSaveNvim.mockResolvedValue();
        mockWriteSavedFile.mockResolvedValue();
        // Default: not in a git repo, so the branch-name yes/no flow is skipped.
        mockBash.execCommand.mockImplementation(async (cmd: string) => {
            if (cmd.includes('display-message')) return bashOk('alpha');
            if (cmd.includes('rev-parse')) throw new Error('not a git repo');

            return bashOk('');
        });
    });

    it('exits early when no sessions are running', async () => {
        mockGetCurrentSessions.mockResolvedValue({});
        await saveSession();
        expect(mockWriteSavedFile).not.toHaveBeenCalled();
        expect(mockSaveNvim).not.toHaveBeenCalled();
    });

    it('writes a single-session JSON containing only the picked session', async () => {
        mockGetCurrentSessions.mockResolvedValue(sampleSessions);
        // Multiple sessions => picker is shown; user picks the attached one (alpha).
        mockUI.searchSelectAndReturnFromArray.mockResolvedValueOnce('alpha');
        // Filename input.
        mockUI.searchAndSelect.mockResolvedValueOnce('my-save');

        await saveSession();

        expect(mockWriteSavedFile).toHaveBeenCalledTimes(1);
        const [folder, name, payload] = mockWriteSavedFile.mock.calls[0];
        expect(folder).toBe('/mock/single/sessions');
        expect(name).toBe('my-save');
        expect(Object.keys(payload)).toEqual(['alpha']);
        expect(mockSaveNvim).toHaveBeenCalledWith({ alpha: sampleSessions.alpha }, 'my-save');
    });

    it('skips picker and uses the only running session when there is exactly one', async () => {
        mockGetCurrentSessions.mockResolvedValue({ solo: { windows: [] } });
        mockUI.searchAndSelect.mockResolvedValueOnce('solo-save');

        await saveSession();

        expect(mockUI.searchSelectAndReturnFromArray).not.toHaveBeenCalled();
        expect(mockWriteSavedFile).toHaveBeenCalledTimes(1);
        const [, name, payload] = mockWriteSavedFile.mock.calls[0];
        expect(name).toBe('solo-save');
        expect(Object.keys(payload)).toEqual(['solo']);
    });

    it('cancels the save when the user picks "cancel" on a name collision', async () => {
        mockGetCurrentSessions.mockResolvedValue({ solo: { windows: [] } });
        mockUI.searchAndSelect
            .mockResolvedValueOnce('existing-save') // initial filename
            .mockResolvedValueOnce('cancel');       // collision prompt
        mockSavedFileExists.mockResolvedValue(true);

        await saveSession();

        expect(mockWriteSavedFile).not.toHaveBeenCalled();
    });

    it('overwrites when the user picks "overwrite" on a name collision', async () => {
        mockGetCurrentSessions.mockResolvedValue({ solo: { windows: [] } });
        mockUI.searchAndSelect
            .mockResolvedValueOnce('existing-save')
            .mockResolvedValueOnce('overwrite');
        mockSavedFileExists.mockResolvedValueOnce(true);

        await saveSession();

        expect(mockWriteSavedFile).toHaveBeenCalledTimes(1);
        expect(mockWriteSavedFile.mock.calls[0][1]).toBe('existing-save');
    });
});
