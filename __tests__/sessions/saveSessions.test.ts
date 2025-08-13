import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import * as sessionUtils from '@/tmux/utils/sessionUtils';
import * as bash from '@/utils/bashHelper';
import * as generalUI from '@/UI/generalUI';
import * as fs from 'fs/promises';
import * as nvim from '@/utils/neovimHelper';

jest.mock('@/tmux/utils/sessionUtils');
jest.mock('@/utils/bashHelper');
jest.mock('@/UI/generalUI');
jest.mock('fs/promises');
jest.mock('@/utils/neovimHelper');

beforeAll(() => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterAll(() => {
  (process.stdout.write as jest.Mock).mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('saveSessionsToFile - no sessions', () => {
    it('should log a message and not write file if no sessions found', async () => {
        (sessionUtils.getCurrentSessions as jest.Mock).mockResolvedValue({});

        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        await saveSessionsToFile();

        expect(consoleLogSpy).toHaveBeenCalledWith('No sessions found to save!');
        expect(fs.writeFile).not.toHaveBeenCalled();

        consoleLogSpy.mockRestore();
    });
});

describe('saveSessionsToFile - with sessions', () => {
    it('should save sessions to file and call nvim.saveNvimSession for nvim sessions', async () => {
        const testSessions = {
            testSession: {
                windows: [
                    {
                        panes: [
                            { currentCommand: 'nvim' },
                            { currentCommand: 'bash' }
                        ]
                    }
                ]
            }
        };

        (sessionUtils.getCurrentSessions as jest.Mock).mockResolvedValue(testSessions);
        (sessionUtils.getDateString as jest.Mock).mockReturnValue('2025-02-18');

        (bash.execCommand as jest.Mock).mockResolvedValue({ stdout: "testBranch\n" });

        (generalUI.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);

        (fs.readdir as jest.Mock).mockResolvedValue(["a", "b"]);

        (generalUI.searchAndSelect as jest.Mock).mockResolvedValue("customName");

        (nvim.saveNvimSession as jest.Mock).mockResolvedValue(undefined);

        await saveSessionsToFile();

        const expectedFileName = "testBranch-customName-2025-02-18";

        expect(nvim.saveNvimSession).toHaveBeenCalledWith(expectedFileName, "testSession", 0, 0);
        expect(fs.writeFile).toHaveBeenCalled();

        const callArgs = (fs.writeFile as jest.Mock).mock.calls[0];

        expect(callArgs[0]).toMatch(new RegExp(`${expectedFileName}$`));
        expect(callArgs[2]).toBe('utf-8');
    });
});
