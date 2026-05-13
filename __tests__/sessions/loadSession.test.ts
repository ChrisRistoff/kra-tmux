import * as generalUI from '@/UI/generalUI';
import { getCurrentSessions } from '@/tmux/utils/sessionUtils';
import * as tmux from '@/tmux/utils/common';
import { createLockFile } from '@/../eventSystem/lockFiles';
import {
    listSavedNames,
    readSavedFile,
    savedFileExists,
} from '@/tmux/utils/savedSessionsIO';
import {
    createBaseSessions,
    executeTmuxScript,
    generateRespawnScript,
} from '@/tmux/utils/sessionRespawn';
import { loadSession } from '@/tmux/commands/loadSession';

jest.mock('@/UI/generalUI');
jest.mock('@/tmux/utils/sessionUtils');
jest.mock('@/tmux/utils/common');
jest.mock('@/../eventSystem/lockFiles');
jest.mock('@/tmux/utils/savedSessionsIO');
jest.mock('@/tmux/utils/sessionRespawn');
jest.mock('@/filePaths', () => ({
    nvimSessionsPath: '/mock/nvim/sessions',
    serverFilesFolder: '/mock/session/files',
    singleSessionFilesFolder: '/mock/single/sessions',
}));

const mockUI = jest.mocked(generalUI);
const mockGetCurrentSessions = jest.mocked(getCurrentSessions);
const mockTmux = jest.mocked(tmux);
const mockCreateLockFile = jest.mocked(createLockFile);
const mockListSavedNames = jest.mocked(listSavedNames);
const mockReadSavedFile = jest.mocked(readSavedFile);
const mockSavedFileExists = jest.mocked(savedFileExists);
const mockCreateBaseSessions = jest.mocked(createBaseSessions);
const mockGenerateRespawnScript = jest.mocked(generateRespawnScript);
const mockExecuteTmuxScript = jest.mocked(executeTmuxScript);

describe('loadSession', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateLockFile.mockResolvedValue(undefined as never);
        mockTmux.sourceTmuxConfig.mockResolvedValue();
        mockSavedFileExists.mockResolvedValue(true);
        mockListSavedNames.mockResolvedValue(['only-save']);
        mockReadSavedFile.mockResolvedValue({ alpha: { windows: [] } });
        mockGetCurrentSessions.mockResolvedValue({});
        mockCreateBaseSessions.mockResolvedValue([{ sessionName: 'alpha', success: true, windows: [] }]);
        mockGenerateRespawnScript.mockReturnValue([]);
        mockExecuteTmuxScript.mockResolvedValue();
        // Default: user accepts the auto-picked file.
        mockUI.searchSelectAndReturnFromArray.mockResolvedValue('only-save');
    });

    it('exits early when there are no saved sessions', async () => {
        mockListSavedNames.mockResolvedValue([]);
        await loadSession();
        expect(mockCreateBaseSessions).not.toHaveBeenCalled();
    });

    it('loads a single session WITHOUT destroying existing sessions when no name collision', async () => {
        mockGetCurrentSessions.mockResolvedValue({ other: { windows: [] } });

        await loadSession();

        expect(mockCreateBaseSessions).toHaveBeenCalledTimes(1);
        expect(mockCreateBaseSessions).toHaveBeenCalledWith(['alpha'], { destroyExisting: false });
        expect(mockTmux.sourceTmuxConfig).toHaveBeenCalled();
        // Crucially we never killed the whole server — there is no killServer call here.
        expect(mockTmux.killServer).not.toHaveBeenCalled();
    });

    it('on collision + overwrite: passes destroyExisting=true', async () => {
        mockGetCurrentSessions.mockResolvedValue({ alpha: { windows: [] } });
        mockUI.searchAndSelect.mockResolvedValueOnce('overwrite');

        await loadSession();

        expect(mockCreateBaseSessions).toHaveBeenCalledWith(['alpha'], { destroyExisting: true });
    });

    it('on collision + cancel: does NOT call createBaseSessions', async () => {
        mockGetCurrentSessions.mockResolvedValue({ alpha: { windows: [] } });
        mockUI.searchAndSelect.mockResolvedValueOnce('cancel');

        await loadSession();

        expect(mockCreateBaseSessions).not.toHaveBeenCalled();
        expect(mockExecuteTmuxScript).not.toHaveBeenCalled();
    });

    it('on collision + rename: uses the renamed target name and does NOT destroy existing', async () => {
        mockGetCurrentSessions.mockResolvedValue({ alpha: { windows: [] } });
        mockUI.searchAndSelect.mockResolvedValueOnce('rename');
        mockUI.askUserForInput.mockResolvedValueOnce('alpha-2');

        await loadSession();

        expect(mockCreateBaseSessions).toHaveBeenCalledWith(['alpha-2'], { destroyExisting: false });
    });

    it('uses the preselected file name when provided (skips picker)', async () => {
        mockReadSavedFile.mockResolvedValue({ beta: { windows: [] } });

        await loadSession('preset-save');

        expect(mockUI.searchSelectAndReturnFromArray).not.toHaveBeenCalled();
        expect(mockReadSavedFile).toHaveBeenCalledWith('/mock/single/sessions', 'preset-save');
        expect(mockCreateBaseSessions).toHaveBeenCalledWith(['beta'], { destroyExisting: false });
    });
});
