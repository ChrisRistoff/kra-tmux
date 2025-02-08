import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@UI/generalUI'
import { aiHistoryPath } from '@/filePaths';
import { aiRoles } from '@AIchat/data/roles';
import { promptModel } from './promptModel';
import { formatChatEntry } from './aiUtils';

export async function saveChat(
    promptFile: string,
    responseFile: string,
    fullPrompt: string,
    temperature: number,
    role: string,
    model: string,
): Promise<void> {
    console.log('Prompt was empty, aborting.');

    const saveFile = await ui.promptUserYesOrNo('Do you want to save the chat history?');

    if (!saveFile) {
        return;
    }

    const fileName = await ui.askUserForInput('Type file name: ');
    const chatData = createChatData(promptFile, responseFile, fullPrompt, temperature, role, model);
    const historyFile = `${aiHistoryPath}/${fileName}/${fileName}`;

    await fs.mkdir(`${aiHistoryPath}/${fileName}`);
    await bash.execCommand(`cp ${responseFile} ${historyFile}.md`);
    await fs.writeFile(`${historyFile}.json`, chatData);

    const chatContent = await fs.readFile(responseFile, 'utf-8');
    const summaryPrompt = `Please provide a concise summary of the following chat conversation.
                            Use bullet points to summaeise, keep each line max 80 chars long.
                            Focus on the main topics discussed and key conclusions:\n\n${chatContent}`;

    const summary = await promptModel(model, summaryPrompt, temperature, aiRoles[role]);
    const formattedSummary = formatChatEntry('Chat Summary', summary);

    const summaryFile = `${aiHistoryPath}/${fileName}/summary.md`;

    await fs.writeFile(summaryFile, formattedSummary);
    await nvim.openNvimInTmuxAndWait(summaryFile);

    const editedSummary = await fs.readFile(summaryFile, 'utf-8');
    await fs.writeFile(`${aiHistoryPath}/${fileName}/summary.md`, editedSummary);

    console.log('Chat and summary saved as ', fileName);
    return;
}

function createChatData(promptFile: string, responseFile: string, fullPrompt: string, temperature: number, role: string, model: string): string {
    return JSON.stringify({
        promptFile,
        responseFile,
        fullPrompt,
        temperature,
        role,
        model,
    }, null, 2)
}
