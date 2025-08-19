import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as bash from '@/utils/bashHelper';
import { nvimSessionsPath } from '@/filePaths';
import { saveNvimSession, loadNvimSession, openVim } from '@/utils/neovimHelper';

// mock entire module so we can override existsSync, mkdirSync and unlinkSync
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

jest.mock('@/utils/bashHelper');

const mockedSendKeysToTmuxTargetSession = jest.mocked(bash.sendKeysToTmuxTargetSession);
const mockedExecCommand = jest.mocked(bash.execCommand);

describe('Nvim Session Operations', () => {
  const folderName = 'testFolder';
  const session = 'testSession';
  const windowIndex = 1;
  const paneIndex = 2;
  const nvimSessionFileName = `${session}_${windowIndex}_${paneIndex}.vim`;
  const fullFolderPath = `${nvimSessionsPath}/${folderName}`;
  const fullSessionPath = `${fullFolderPath}/${nvimSessionFileName}`;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('saveNvimSession', () => {
    let existsSyncMock: jest.Mock;
    let mkdirSyncMock: jest.Mock;
    let unlinkSyncMock: jest.Mock;

    beforeEach(() => {
      existsSyncMock = fs.existsSync as jest.Mock;
      mkdirSyncMock = fs.mkdirSync as jest.Mock;
      unlinkSyncMock = fs.unlinkSync as jest.Mock;

      // By default, assume that none of the directories or the file exist.
      existsSyncMock.mockImplementation((_path: string) => false);
      mockedSendKeysToTmuxTargetSession.mockResolvedValue(undefined);
    });

    it('should create directories if they do not exist and then save the session', async () => {
      await saveNvimSession(folderName, session, windowIndex, paneIndex);

      expect(mkdirSyncMock).toHaveBeenCalledWith(nvimSessionsPath, { recursive: true });
      expect(mkdirSyncMock).toHaveBeenCalledWith(fullFolderPath, { recursive: true });
      expect(unlinkSyncMock).not.toHaveBeenCalled();
      expect(mockedSendKeysToTmuxTargetSession).toHaveBeenCalledWith({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `:mksession ${fullSessionPath}`,
      });
    });

    it('should delete the existing session file before saving a new one', async () => {
      existsSyncMock.mockImplementation((path: string) => {
        if (path === nvimSessionsPath) return true;
        if (path === fullFolderPath) return true;
        if (path === fullSessionPath) return true;
        return false;
      });

      await saveNvimSession(folderName, session, windowIndex, paneIndex);

      expect(unlinkSyncMock).toHaveBeenCalledWith(fullSessionPath);
      expect(mockedSendKeysToTmuxTargetSession).toHaveBeenCalledWith({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `:mksession ${fullSessionPath}`,
      });
    });
  });

  describe('loadNvimSession', () => {
    beforeEach(() => {
      mockedSendKeysToTmuxTargetSession.mockResolvedValue(undefined);
    });

    it('should load the saved session in nvim', async () => {
      await loadNvimSession(folderName, session, windowIndex, paneIndex);

      expect(mockedSendKeysToTmuxTargetSession).toHaveBeenCalledWith({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `nvim -S ${fullSessionPath}`,
      });
    });
  });

  describe('openVim', () => {
    const filePath = '/path/to/file.txt';
    let spawnMock: jest.SpyInstance;

    beforeEach(() => {
      mockedExecCommand.mockResolvedValue({ stdout: '', stderr: '' });
      spawnMock = jest.spyOn(require('child_process'), 'spawn');
    });

    afterEach(() => {
      spawnMock.mockRestore();
    });

    // Helper to create a fake child process that is an EventEmitter.
    function createFakeProcess(): EventEmitter {
      return new EventEmitter();
    }

    it('should resolve when nvim process exits with code 0', async () => {
      const fakeProcess = createFakeProcess();
      spawnMock.mockReturnValue(fakeProcess as any);

      const promise = openVim(filePath);
      process.nextTick(() => {
        fakeProcess.emit('close', 0);
      });

      await expect(promise).resolves.toBeUndefined();
      expect(spawnMock).toHaveBeenCalledWith('nvim', [filePath], {
        stdio: 'inherit',
        shell: false,
      });
    });

    it('should resolve and send tmux keys when colon-prefixed args are provided', async () => {
      const argWithColon = ':SomeCommand';
      const fakeProcess = createFakeProcess();
      spawnMock.mockReturnValue(fakeProcess as any);

      const promise = openVim(filePath, argWithColon, 'anotherArg');
      process.nextTick(() => {
        fakeProcess.emit('close', 0);
      });

      await expect(promise).resolves.toBeUndefined();
      expect(mockedExecCommand).toHaveBeenCalledWith(`tmux send-keys ${argWithColon} C-m`);
      expect(spawnMock).toHaveBeenCalledWith('nvim', [filePath, argWithColon, 'anotherArg'], {
        stdio: 'inherit',
        shell: false,
      });
    });

    it('should reject when nvim process exits with non-zero code', async () => {
      const fakeProcess = createFakeProcess();
      spawnMock.mockReturnValue(fakeProcess as any);

      const promise = openVim(filePath);
      process.nextTick(() => {
        fakeProcess.emit('close', 1);
      });

      await expect(promise).rejects.toThrow('Vim exited with code 1');
    });

    it('should reject when nvim process emits an error', async () => {
      const fakeProcess = createFakeProcess();
      spawnMock.mockReturnValue(fakeProcess as any);

      const error = new Error('Spawn failed');
      const promise = openVim(filePath);
      process.nextTick(() => {
        fakeProcess.emit('error', error);
      });

      await expect(promise).rejects.toThrow('Spawn failed');
    });
  });
});
