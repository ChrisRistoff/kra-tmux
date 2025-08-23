import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@/UI/generalUI';
import * as conversation from '@/AIchat/main/conversation';
import { loadChat } from '@/AIchat/commands/loadChat';
import { aiHistoryPath } from '@/filePaths';
import { pickProviderAndModel } from '@/AIchat/utils/aiUtils';
import { providers } from '@/AIchat/data/models';
import * as path from 'path';

jest.mock('fs/promises');
jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');
jest.mock('@/UI/generalUI');
jest.mock('@/AIchat/main/conversation');
jest.mock('@/AIchat/utils/aiUtils');
jest.mock('@/utils/common', () => ({
    filterGitKeep: jest.fn((chats) => chats)
}));

describe('loadChat', () => {
    const savedChatName = 'chat1';
    const fakeChats = [savedChatName];
    const fixedTimestamp = 123456789;
    const chatFile = `/tmp/ai-chat-${fixedTimestamp}.md`;
    const chatHistoryPath = path.join(aiHistoryPath, savedChatName, `${savedChatName}.md`);
    const chatSummaryPath = path.join(aiHistoryPath, savedChatName, 'summary.md');

    const validChatData = {
        temperature: 0.6,
        role: 'testRole',
        provider: 'providerA',
        model: 'model1'
    };

    const invalidChatData = {
        temperature: 0.6,
        role: 'testRole',
        provider: 'providerA',
        model: 'invalidModel'
    };

    beforeAll(() => {
        providers['providerA'] = { model: 'model1' };
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Date, 'now').mockReturnValue(fixedTimestamp);
        delete process.env.TMUX;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should print message and return when no saved chats are found', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue([]);
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        await loadChat();

        expect(fs.readdir).toHaveBeenCalledWith(aiHistoryPath);
        expect(consoleLogSpy).toHaveBeenCalledWith('No saved chats found.');
        consoleLogSpy.mockRestore();
    });

    it('should load chat and call conversation.converse when provider is valid and TMUX is not set', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(nvim.openVim).toHaveBeenCalledWith(chatSummaryPath);
        expect(fs.copyFile).toHaveBeenCalledWith(chatHistoryPath, chatFile);
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true
        );
    });

    it('should call bash.execCommand with tmux command when TMUX is set', async () => {
        process.env.TMUX = '1';
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(bash.execCommand).toHaveBeenCalled();
        expect(nvim.openVim).not.toHaveBeenCalled();
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true
        );
    });

    it('should prompt for new provider and model if the saved chat has invalid provider', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(invalidChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);
        (pickProviderAndModel as jest.Mock).mockResolvedValue({ provider: 'providerA', model: 'model1' });

        await loadChat();

        expect(pickProviderAndModel).toHaveBeenCalled();
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            invalidChatData.temperature,
            invalidChatData.role,
            'providerA',
            'model1',
            true
        );
    });

    it('should recursively call loadChat if user declines to open the chat', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);

        const promptUserYesOrNoMock = ui.promptUserYesOrNo as jest.Mock;
        promptUserYesOrNoMock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(promptUserYesOrNoMock).toHaveBeenCalledTimes(2);
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true
        );
    });

    it('should log error and rethrow if an error occurs', async () => {
        const testError = new Error('Test error');
        (fs.readdir as jest.Mock).mockRejectedValue(testError);
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await expect(loadChat()).rejects.toThrow('Test error');
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error loading chat:', 'Test error');
        consoleErrorSpy.mockRestore();
    });
});
