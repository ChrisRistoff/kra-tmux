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

export async function saveChat(
    chatFile: string,
    fullPrompt: string,
    temperature: number,
    role: string,
    model: string,
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

    const chatData = createChatData(chatFile, fullPrompt, temperature, role, model);
    const historyFile = `${aiHistoryPath}/${saveName}/${saveName}`;

    await fs.mkdir(`${aiHistoryPath}/${saveName}`);
    await bash.execCommand(`cp ${chatFile} ${historyFile}.md`);
    await fs.writeFile(`${historyFile}.json`, chatData);

    const chatContent = await fs.readFile(chatFile, 'utf-8');

    const finalSummaryPrompt = `${summaryPrompt}:\n\n${chatContent}`;

    console.log('Preparing summary...')
    const summary = await promptModel('gemini-flash', finalSummaryPrompt, temperature, aiRoles[role]);

    let fullResponse = '';
    for await (const chunk of summary) {
        const text = chunk.text();
        fullResponse += text;
    }

    const formattedSummary = formatChatEntry('Chat Summary', fullResponse as string, true);
    const summaryFile = `${aiHistoryPath}/${saveName}/summary.md`;

    await fs.writeFile(summaryFile, formattedSummary);

    if (process.env.TMUX) {
        await nvim.openNvimInTmuxAndWait(summaryFile);
    } else {
        nvim.openVim(summaryFile);
    }

    const editedSummary = await fs.readFile(summaryFile, 'utf-8');
    await fs.writeFile(`${aiHistoryPath}/${saveName}/summary.md`, editedSummary);

    console.log('Chat and summary saved as ', saveName);
    return;
}

function createChatData(chatFile: string, fullPrompt: string, temperature: number, role: string, model: string): string {
    return JSON.stringify({
        chatFile,
        fullPrompt,
        temperature,
        role,
        model,
    }, null, 2)
}
