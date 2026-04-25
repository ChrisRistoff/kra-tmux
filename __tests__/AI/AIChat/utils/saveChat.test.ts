import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@/UI/generalUI';
import { saveChat } from '@/AI/AIChat/utils/saveChat';
import { promptModel } from '@/AI/AIChat/utils/promptModel';
import { aiHistoryPath } from '@/filePaths';
import { ChatHistory, Role } from '@/AI/shared/types/aiTypes';

jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');
jest.mock('@/UI/generalUI');
jest.mock('fs/promises');
jest.mock('@/AI/AIChat/utils/promptModel');
jest.mock('@/AI/AIChat/utils/aiUtils', () => ({
    formatChatEntry: jest.fn((title, text, _flag) => `Formatted: ${title}: ${text}`)
}));

describe('saveChat', () => {
    const chatFile = 'dummyChat.txt';
    const temperature = 0.5;
    const role = 'user';
    const provider = 'gemini';
    const model = 'dummyModel';
    const saveName = 'testSave';
    const chatContent = 'Chat content from file';
    const chatHistory: ChatHistory[] = [
        { role: Role.User, message: 'test', timestamp: 'date'},
        { role: Role.AI, message: 'test response', timestamp: 'date'},
    ]

    const exit = jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit called'); }) as any);

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.TMUX;
    });

    afterEach(() => {
        exit.mockRestore();
    });

    it('should not save chat if user declines', async () => {
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(false);
        (fs.readdir as jest.Mock).mockResolvedValue([]);
        (promptModel as jest.Mock).mockImplementation(async function* () {});

        try {
            await saveChat(chatFile, provider, model, role, temperature, chatHistory);
        } catch (e) {
            expect((e as Error).message).toBe('process.exit called');
        }

        expect(ui.promptUserYesOrNo).toHaveBeenCalledWith('Do you want to save the chat history?');
        expect(ui.searchAndSelect).not.toHaveBeenCalled();
        expect(bash.execCommand).not.toHaveBeenCalled();
    });

    it('should save chat and summary when TMUX is not set', async () => {
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readdir as jest.Mock).mockResolvedValue([]);
        (ui.searchAndSelect as jest.Mock).mockResolvedValue(saveName);
        (fs.readFile as jest.Mock).mockResolvedValue(chatContent);

        (promptModel as jest.Mock).mockImplementation(async function* () {
            yield "Generated summary";
        });

        await saveChat(chatFile, provider, model, role, temperature, chatHistory);

        const expectedSavePath = `${aiHistoryPath}/${saveName}`;
        const expectedHistoryFile = `${expectedSavePath}/${saveName}`;

        expect(fs.mkdir).toHaveBeenCalledWith(expectedSavePath);
        expect(fs.writeFile).toHaveBeenCalledWith(`${expectedHistoryFile}.json`, expect.any(String));

        expect(nvim.openVim).toHaveBeenCalledWith(`${expectedSavePath}/summary.md`);
    });

    it('should save chat and summary when TMUX is set', async () => {
        process.env.TMUX = '1';
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readdir as jest.Mock).mockResolvedValue([saveName]);
        (ui.searchAndSelect as jest.Mock).mockResolvedValue(saveName);
        (fs.readFile as jest.Mock).mockResolvedValue(chatContent);

        (promptModel as jest.Mock).mockImplementation(async function* () {
            yield "Summary chunk";
        });

        await saveChat(chatFile, provider, model, role, temperature, chatHistory);

        const expectedSavePath = `${aiHistoryPath}/${saveName}`;

        expect(bash.execCommand).toHaveBeenCalledWith(`rm -rf ${aiHistoryPath}/${saveName}`);

        expect(fs.mkdir).toHaveBeenCalledWith(expectedSavePath);

        const tmuxCommandMatcher = expect.stringContaining('tmux split-window');
        expect(bash.execCommand).toHaveBeenCalledWith(tmuxCommandMatcher);
        expect(nvim.openVim).not.toHaveBeenCalled();
    });
});
