import * as fs from 'fs/promises';
import * as path from 'path';
import * as utils from '@AIchat/utils/aiUtils';
import * as ui from '@UI/generalUI';
import { aiHistoryPath } from '@/filePaths';
import * as nvim from '@/utils/neovimHelper';
import { filterGitKeep } from '@/utils/common';

export async function loadChat(): Promise<void> {
    try {
        const savedChats = await fs.readdir(aiHistoryPath);

        if (savedChats.length === 0) {
            console.log('No saved chats found.');
            return;
        }

        const selectedChat = await ui.searchSelectAndReturnFromArray({
            itemsArray: filterGitKeep(savedChats),
            prompt: 'Select a chat to load: '
        });

        const timestamp = Date.now();
        const tempDir = path.join('/tmp', `ai-chat-${timestamp}`);
        await fs.mkdir(tempDir, { recursive: true });

        const chatFile = path.join(tempDir, 'conversation.md');

        const chatDataPath = path.join(aiHistoryPath, selectedChat, `${selectedChat}.json`);
        const chatHistoryPath = path.join(aiHistoryPath, selectedChat, `${selectedChat}.md`);
        const chatSummaryPath= path.join(aiHistoryPath, selectedChat, 'summary.md');

        await nvim.openNvimInTmuxAndWait(chatSummaryPath);

        const loadTheChat = await ui.promptUserYesOrNo('Do you want to open this chat?');

        if (!loadTheChat) {
            return await loadChat();
        }

        const chatData = JSON.parse(await fs.readFile(chatDataPath, 'utf-8'));

        await fs.copyFile(chatHistoryPath, chatFile);

        const chatFileLoaded = true;
        await utils.converse(
            chatFile,
            chatData.temperature,
            chatData.role,
            chatData.model,
            chatFileLoaded
        );
    } catch (error) {
        console.error('Error loading chat:', (error as Error).message);
        throw error;
    }
}
