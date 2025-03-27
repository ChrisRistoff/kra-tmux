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
    temperature: number,
    role: string,
    provider: string,
    model: string,
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

    const chatData = createChatData(chatFile, temperature, role, provider, model, chatHistory);
    const historyFile = `${aiHistoryPath}/${saveName}/${saveName}`;

    await fs.mkdir(`${aiHistoryPath}/${saveName}`);
    await bash.execCommand(`cp ${chatFile} ${historyFile}.md`);
    await fs.writeFile(`${historyFile}.json`, chatData);

    const chatContent = await fs.readFile(chatFile, 'utf-8');

    const finalSummaryPrompt = `${summaryPrompt}:\n\n${chatContent}`;

    console.log('Preparing summary...')
    const summary = await promptModel('gemini', providers['gemini']['gemini-thinking'], finalSummaryPrompt, temperature, aiRoles[role]);

    let fullResponse = '';
    for await (const chunk of summary) {
        fullResponse += chunk;
    }

    const formattedSummary = formatChatEntry('Chat Summary', fullResponse, true);
    const summaryFile = `${aiHistoryPath}/${saveName}/summary.md`;

    await fs.writeFile(summaryFile, formattedSummary);

    if (process.env.TMUX) {
        const tmuxCommand = `tmux split-window -v -p 90 -c "#{pane_current_path}" \; \
            tmux send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim  \\"${summaryFile}\\";
            tmux send-keys exit C-m"' C-m`

        bash.execCommand(tmuxCommand);
    } else {
        nvim.openVim(summaryFile);
    }

    const editedSummary = await fs.readFile(summaryFile, 'utf-8');
    await fs.writeFile(`${aiHistoryPath}/${saveName}/summary.md`, editedSummary);

    console.log('Chat and summary saved as ', saveName);

    return;
}

function createChatData(chatFile: string, temperature: number, role: string, provider: string, model: string, chatHistory: ChatHistory[]): string {
    const chatData: ChatData = {
        chatFile,
        temperature,
        role,
        provider,
        model,
        chatHistory
    }

    return JSON.stringify(chatData, null, 2)
}
