import * as fs from 'fs/promises';
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { generateText } from "ai";
import * as bash from '@utils/bashHelper';
import * as keys from '@AI/data/keys';
import * as utils from '@AI/utils/aiUtils';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@UI/generalUI'
import { aiRoles } from '../data/roles';
import { models } from '../data/models';
import path from 'path';
import { aiHistoryPath } from '@/filePaths';

export async function generalPrompt(): Promise<void> {
    try {
        const timestamp = Date.now();
        const tempDir = path.join('/tmp', `ai-chat-${timestamp}`);
        await fs.mkdir(tempDir, { recursive: true });

        const tempFiles = {
            promptFile: path.join(tempDir, 'prompt.md'),
            responseFile: path.join(tempDir, 'conversation.md')
        };

        await initializeChatFile(tempFiles.responseFile);
        await clearPromptFile(tempFiles.promptFile);

        const temperature = await utils.promptUserForTemperature();

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        console.log('Opening vim for prompt...');
        await converse(tempFiles.promptFile, tempFiles.responseFile, temperature, role);

        await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}

async function converse(
    promptFile: string,
    responseFile: string,
    temperature: number,
    role: string
): Promise<void> {
    try {
        await Promise.all([
            ensureFileExists(promptFile),
            ensureFileExists(responseFile)
        ]);

        await clearPromptFile(promptFile);

        await nvim.openNvimInTmuxAndWait(promptFile);
        console.log('Vim session completed');

        const prompt = await fs.readFile(promptFile, 'utf-8');

        if (!prompt.trim()) {
            console.log('Prompt was empty, aborting.');

            console.log(responseFile);

            const saveFile = await ui.promptUserYesOrNo('Do you want to save the chat history?');

            if (!saveFile) {
                return;
            }

            const fileName = await ui.askUserForInput('Type file name: ');

            await bash.execCommand(`cp ${responseFile} ${aiHistoryPath}/${fileName}.md`);

            return;
        }

        const res = await generateText({
            model: createDeepInfra({apiKey: keys.getDeepSeekKey()})(models.deepSeekR1),
            prompt,
            maxTokens: 4096,
            temperature: temperature / 10,
            system: aiRoles[role],
        });

        const userEntry = formatChatEntry('User', prompt);
        const aiEntry = formatChatEntry('AI', res.text);

        await appendToChat(responseFile, userEntry);
        await appendToChat(responseFile, aiEntry);

        console.log(`Successfully wrote response to: ${responseFile}`);

        await nvim.openNvimInTmuxAndWait(responseFile);

        return await converse(promptFile, responseFile, temperature, role);
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}

async function initializeChatFile(filePath: string): Promise<void> {
    const initialContent = `# AI Chat History\n\nThis file contains the conversation history between the user and AI.\n\n---\n\n`;
    await fs.writeFile(filePath, initialContent, 'utf-8');
}

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

function formatChatEntry(role: string, content: string): string {
    const timestamp = new Date().toISOString();
    return `### ${role} (${timestamp})\n\n${content}\n\n---\n\n`;
}

async function ensureFileExists(filePath: string): Promise<void> {
    try {
        await fs.access(filePath);
    } catch {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await initializeChatFile(filePath);
    }
}

async function clearPromptFile(promptFile: string): Promise<void> {
    await fs.writeFile(promptFile, '', 'utf-8');
}
