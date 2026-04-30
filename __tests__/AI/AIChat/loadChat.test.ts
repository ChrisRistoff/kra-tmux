import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@/UI/generalUI';
import * as conversation from '@/AI/AIChat/main/conversation';
import { loadChat } from '@/AI/AIChat/commands/loadChat';
import { aiHistoryPath } from '@/filePaths';
import { pickProviderAndModel } from '@/AI/AIChat/utils/aiUtils';
import { getModelCatalog } from '@/AI/shared/data/modelCatalog';
import { Role } from '@/AI/shared/types/aiTypes';
import * as path from 'path';

jest.mock('fs/promises');
jest.mock('@/utils/bashHelper');
jest.mock('@/utils/neovimHelper');
jest.mock('@/UI/generalUI');
jest.mock('@/AI/AIChat/main/conversation');
jest.mock('@/AI/AIChat/utils/aiUtils', () => ({
    formatChatEntry: jest.fn((_title: string, content: string) => content),
    pickProviderAndModel: jest.fn(),
}));
jest.mock('@/utils/common', () => ({
    filterGitKeep: jest.fn((chats) => chats)
}));
jest.mock('@/AI/shared/data/modelCatalog', () => ({
    getModelCatalog: jest.fn(),
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
        provider: 'gemini',
        model: 'model1',
        summary: 'Saved summary',
        chatHistory: [],
    };

    const invalidChatData = {
        temperature: 0.6,
        role: 'testRole',
        provider: 'gemini',
        model: 'invalidModel',
        summary: 'Saved summary',
        chatHistory: [],
    };

    beforeAll(() => {
        (getModelCatalog as jest.Mock).mockResolvedValue([
            { id: 'model1', label: 'model1', contextWindow: 128_000 },
        ]);
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
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { return });

        await loadChat();

        expect(fs.readdir).toHaveBeenCalledWith(aiHistoryPath);
        expect(consoleLogSpy).toHaveBeenCalledWith('No saved chats found.');
        consoleLogSpy.mockRestore();
    });

    it('should load chat and call conversation.converse when provider is valid', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
        (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(ui.searchSelectAndReturnFromArray).toHaveBeenCalledWith(expect.objectContaining({
            itemsArray: fakeChats,
            prompt: 'Select a chat to load',
            header: '1 saved chat(s)',
            details: expect.any(Function),
        }));
        expect(fs.writeFile).toHaveBeenCalledWith(chatSummaryPath, 'Saved summary\n');
        expect(fs.copyFile).toHaveBeenCalledWith(chatHistoryPath, chatFile);
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true,
        );
        expect(nvim.openVim).not.toHaveBeenCalled();
    });

    it('should ignore TMUX and keep the same load flow', async () => {
        process.env.TMUX = '1';
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
        (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(bash.execCommand).not.toHaveBeenCalled();
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true,
        );
    });

    it('should rebuild saved chat history without appending a blank draft user turn', async () => {
        const chatDataWithHistory = {
            ...validChatData,
            chatHistory: [
                { role: Role.User, message: 'First prompt', timestamp: '2026-04-28T10:00:00.000Z' },
                { role: Role.AI, message: 'First reply', timestamp: '2026-04-28T10:00:01.000Z' },
            ],
        };

        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(chatDataWithHistory));
        (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(conversation.initializeChatFile).toHaveBeenCalledWith(chatFile);
        expect(fs.appendFile).toHaveBeenCalledWith(chatFile, expect.stringContaining('First prompt'));

        const transcript = (fs.appendFile as jest.Mock).mock.calls[0][1] as string;
        expect((transcript.match(/USER PROMPT/g) ?? [])).toHaveLength(1);
    });

    it('should prompt for new provider and model if the saved chat has invalid provider', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (ui.promptUserYesOrNo as jest.Mock).mockResolvedValue(true);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(invalidChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);
        (pickProviderAndModel as jest.Mock).mockResolvedValue({ provider: 'gemini', model: 'model1' });

        await loadChat();

        expect(pickProviderAndModel).toHaveBeenCalled();
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            invalidChatData.temperature,
            invalidChatData.role,
            'gemini',
            'model1',
            true
        );
    });

    it('should open the selected chat without confirmation prompts', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue(fakeChats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(savedChatName);
        (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(validChatData));
        (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
        (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
        (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);

        await loadChat();

        expect(ui.promptUserYesOrNo).not.toHaveBeenCalled();
        expect(conversation.converse).toHaveBeenCalledWith(
            chatFile,
            validChatData.temperature,
            validChatData.role,
            validChatData.provider,
            validChatData.model,
            true,
        );
    });

    it('should log error and rethrow if an error occurs', async () => {
        const testError = new Error('Test error');
        (fs.readdir as jest.Mock).mockRejectedValue(testError);
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { return });

        await expect(loadChat()).rejects.toThrow('Test error');
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error loading chat:', 'Test error');
        consoleErrorSpy.mockRestore();
    });
});
