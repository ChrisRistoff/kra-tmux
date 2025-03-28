import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@UI/generalUI'
import { aiHistoryPath } from '@/filePaths';
import { aiRoles } from '@AIchat/data/roles';
import { promptModel } from './promptModel';
import { formatChatEntry } from './aiUtils';
import { summaryPrompt } from '../data/prompts';
import { filterGitKeep } from '@/utils/common';
import { providers } from '../data/models';
import { ChatData, ChatHistory } from '../types/aiTypes';

export async function saveChat(
    chatFile: string,
    provider: string,
    model: string,
    role: string,
    temperature: number,
    chatHistory: ChatHistory[]
): Promise<void> {
    const saveFile = await ui.promptUserYesOrNo('Do you want to save the chat history?');

    if (!saveFile) {
        return;
    }

    const saves = filterGitKeep(await fs.readdir(aiHistoryPath));

    const saveName = await ui.searchAndSelect({
        itemsArray: saves,
        prompt: 'Type file name: '
    });

    if (saves.includes(saveName)) {
        await bash.execCommand(`rm -rf ${aiHistoryPath}/${saveName}`);
    }

    const historyFile = `${aiHistoryPath}/${saveName}/${saveName}`;

    await fs.mkdir(`${aiHistoryPath}/${saveName}`);

    const chatContent = await fs.readFile(chatFile, 'utf-8');

    const finalSummaryPrompt = `${summaryPrompt}:\n\n${chatContent}`;

    console.log('Preparing summary...')
    const summary = await promptModel('gemini', providers['gemini']['gemini-thinking'], finalSummaryPrompt, temperature, aiRoles[role]);

    let fullResponse = '';
    for await (const chunk of summary) {
        fullResponse += chunk;
    }

    const chatData = createChatData(saveName, fullResponse, provider, model, role, temperature, chatHistory);

    await fs.writeFile(`${historyFile}.json`, chatData);

    const formattedSummary = formatChatEntry('Chat Summary', fullResponse, true);
    const summaryFile = `${aiHistoryPath}/${saveName}/summary.md`;

    await fs.writeFile(summaryFile, formattedSummary);

    if (process.env.TMUX) {
        const tmuxCommand = `tmux split-window -v -p 90 -c "#{pane_current_path}" \; \
            tmux send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim  \\"${summaryFile}\\";
            tmux send-keys exit C-m"' C-m`

        await bash.execCommand(tmuxCommand);
    } else {
        await nvim.openVim(summaryFile);
    }

    console.log('Chat saved as ', saveName);

    return;
}

function createChatData(
    title: string,
    summary: string,
    provider: string,
    model: string,
    role: string,
    temperature: number,
    chatHistory: ChatHistory[]
): string {
    const chatData: ChatData = {
        title,
        summary,
        provider,
        model,
        role,
        temperature,
        chatHistory
    }

    return JSON.stringify(chatData, null, 2)
}
