import * as fs from 'fs/promises';
import { ChatData, ChatHistory, SavedFileContext } from '@/AI/shared/types/aiTypes';
import { summaryPrompt } from '@/AI/AIChat/data/prompts';
import { formatChatEntry } from '@/AI/AIChat/utils/aiUtils';
import { aiRoles } from '@/AI/shared/data/roles';
import { promptModel } from '@/AI/AIChat/utils/promptModel';
import * as bash from '@/utils/bashHelper';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@/UI/generalUI';
import { aiHistoryPath } from '@/filePaths';
import { filterGitKeep } from '@/utils/common';
import { menuChain } from '@/UI/menuChain';

export async function saveChat(
    chatFile: string,
    provider: string,
    model: string,
    role: string,
    temperature: number,
    chatHistory: ChatHistory[]
): Promise<void> {
    const saves = filterGitKeep(await fs.readdir(aiHistoryPath));

    const { saveFile, saveName } = await menuChain()
        .step('saveFile', async () => ui.promptUserYesOrNo('Do you want to save the chat history?'))
        .step('saveName', async (d) => (d.saveFile)
            ? ui.searchAndSelect({ itemsArray: saves, prompt: 'Type file name: ' })
            : Promise.resolve('')
        )
        .run();

    if (!saveFile) {
        process.exit(0);
    }

    if (saves.includes(saveName)) {
        await bash.execCommand(`rm -rf ${aiHistoryPath}/${saveName}`);
    }

    const historyFile = `${aiHistoryPath}/${saveName}/${saveName}`;

    await fs.mkdir(`${aiHistoryPath}/${saveName}`);

    // Build the summary prompt from in-memory `chatHistory` instead of
    // re-reading the chatFile. The chatFile is no longer the source of
    // truth for the running TUI — it's an empty/transient file at this
    // point. Reading it would feed an empty/stale string to the summary
    // model and produce garbage summaries.
    const chatContent = chatHistory
        .map((entry) => formatChatEntry(entry.role, entry.message))
        .join('\n');
    void chatFile;

    const finalSummaryPrompt = `${summaryPrompt}:\n\n${chatContent}`;

    console.log('Preparing summary...')
    const summary = await promptModel('gemini', 'gemini-2.5-flash', [{ role: 'user', content: finalSummaryPrompt }], temperature, aiRoles[role]);

    let fullResponse = '';
    for await (const chunk of summary) {
        fullResponse += chunk;
    }

    const chatData = createChatData(saveName, fullResponse, provider, model, role, temperature, chatHistory);

    await fs.writeFile(`${historyFile}.json`, chatData);

    const formattedSummary = formatChatEntry('Chat Summary', fullResponse + '\n', true);
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
    chatHistory: ChatHistory[],
    fileContexts?: SavedFileContext[]
): string {
    const chatData: ChatData = {
        title,
        summary,
        provider,
        model,
        role,
        temperature,
        chatHistory,
        fileContexts,
    }

    return JSON.stringify(chatData, null, 2)
}
