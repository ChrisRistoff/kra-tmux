import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@UI/generalUI';
import { saveChat } from '@AIchat/utils/saveChat';
import { promptModel } from '@AIchat/utils/promptModel';
import { aiHistoryPath } from '@/filePaths';
import { ChatHistory, Role } from '@/AIchat/types/aiTypes';

jest.mock('@utils/bashHelper');
jest.mock('@utils/neovimHelper');
jest.mock('@UI/generalUI');
jest.mock('fs/promises');
jest.mock('@AIchat/utils/promptModel');
jest.mock('@AIchat/utils/aiUtils', () => ({
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

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.TMUX;
    });

    it('should not save chat if user declines', async () => {
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(false);

        await saveChat(chatFile, temperature, role, provider, model, chatHistory);

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

        await saveChat(chatFile, temperature, role, provider, model, chatHistory);

        const expectedSavePath = `${aiHistoryPath}/${saveName}`;
        const expectedHistoryFile = `${expectedSavePath}/${saveName}`;

        expect(fs.mkdir).toHaveBeenCalledWith(expectedSavePath);
        expect(bash.execCommand).toHaveBeenCalledWith(`cp ${chatFile} ${expectedHistoryFile}.md`);
        expect(fs.writeFile).toHaveBeenCalledWith(`${expectedHistoryFile}.json`, expect.any(String));

        const formattedSummary = `Formatted: Chat Summary: Generated summary`;
        expect(fs.writeFile).toHaveBeenCalledWith(`${expectedSavePath}/summary.md`, formattedSummary);

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

        await saveChat(chatFile, temperature, role, provider, model, chatHistory);

        const expectedSavePath = `${aiHistoryPath}/${saveName}`;
        const expectedHistoryFile = `${expectedSavePath}/${saveName}`;

        expect(bash.execCommand).toHaveBeenCalledWith(`rm -rf ${aiHistoryPath}/${saveName}`);

        expect(fs.mkdir).toHaveBeenCalledWith(expectedSavePath);
        expect(bash.execCommand).toHaveBeenCalledWith(`cp ${chatFile} ${expectedHistoryFile}.md`);

        const formattedSummary = `Formatted: Chat Summary: Summary chunk`;
        expect(fs.writeFile).toHaveBeenCalledWith(`${expectedSavePath}/summary.md`, formattedSummary);

        const tmuxCommandMatcher = expect.stringContaining('tmux split-window');
        expect(bash.execCommand).toHaveBeenCalledWith(tmuxCommandMatcher);
        expect(nvim.openVim).not.toHaveBeenCalled();
    });
});
