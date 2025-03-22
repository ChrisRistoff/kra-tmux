import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import * as path from 'path';
import * as conversation from '@AIchat/utils/conversation';
import * as ui from '@UI/generalUI';
import { aiHistoryPath } from '@/filePaths';
import * as nvim from '@/utils/neovimHelper';
import { filterGitKeep } from '@/utils/common';
import { providers } from '../data/models';
import { pickProviderAndModel } from '../utils/aiUtils';
import { Role } from '../types/aiTypes';

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
        const chatFile = `/tmp/ai-chat-${timestamp}.md`;

        const chatDataPath = path.join(aiHistoryPath, selectedChat, `${selectedChat}.json`);
        const chatSummaryPath = path.join(aiHistoryPath, selectedChat, 'summary.md');

        if (process.env.TMUX) {
            const tmuxCommand = `tmux split-window -v -p 90 -c "#{pane_current_path}" \; \
                tmux send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim  \\"${chatSummaryPath}\\";
                tmux send-keys exit C-m"' C-m`

            bash.execCommand(tmuxCommand);
        } else {
            nvim.openVim(chatSummaryPath);
        }

        const loadTheChat = await ui.promptUserYesOrNo('Do you want to open this chat?');

        if (!loadTheChat) {
            return await loadChat();
        }

        const chatData = JSON.parse(await fs.readFile(chatDataPath, 'utf-8'));

        const chatHistoryContent = await fs.readFile(chatDataPath, 'utf-8');
        const chatHistoryData = JSON.parse(chatHistoryContent);
        const chatTranscript = formatFullChat(chatHistoryData);

        if (chatTranscript.length > 0) {
            fs.writeFile(chatFile, chatTranscript);
        } else {
            const chatHistoryPath = path.join(aiHistoryPath, selectedChat, `${selectedChat}.md`);
            await fs.copyFile(chatHistoryPath, chatFile);
        }


        if (!chatData.provider || !checkProviderAndModelValid(chatData.provider, chatData.model)) {
            console.log('Pick a new provider');
            console.log('Old model on save: ', chatData.model);

            const { provider, model } = await pickProviderAndModel();

            chatData.provider = provider;
            chatData.model = model;
        }

        const chatFileLoaded = true;
        await conversation.converse(
            chatFile,
            chatData.temperature,
            chatData.role,
            chatData.provider,
            chatData.model,
            chatFileLoaded
        );
    } catch (error) {
        console.error('Error loading chat:', (error as Error).message);
        throw error;
    }
}

function formatFullChat(chatData: any): string {
    return chatData.chatHistory.map((entry: any) => {
        if (entry.role === Role.AI) {
            return `### ${entry.role} - ${chatData.model} - ${entry.timestamp}\n\n${entry.message}\n\n`
        }

        return `### ${entry.role} - ${entry.timestamp}\n\n${entry.message}\n\n`
    }).join('');
}

function checkProviderAndModelValid(provider: string, model: string): boolean {
    return Object.keys(providers[provider]).some((value) => providers[provider][value] === model);
}
