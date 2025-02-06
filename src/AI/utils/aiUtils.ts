import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { generateText } from "ai";
import * as bash from '@utils/bashHelper';
import * as keys from '@AI/data/keys';
import * as nvim from '@/utils/neovimHelper';
import { aiHistoryPath } from '@/filePaths';
import { models } from '../data/models';
import * as ui from '@UI/generalUI'
import { aiRoles } from '../data/roles';

export async function promptUserForTemperature() {
    const optionsArray = Array.from({length: 10}, (_, i) => (i + 1).toString());
    const { selectedOption } = await inquirer.prompt([
        {
            type: 'autocomplete',
            name: 'selectedOption',
            message: 'Choose temperatur 1-10(0.1 - 1.0)',
            source: (_answersSoFar: string[], input: string) => {
                if (!input) {
                  return optionsArray
                }

                return optionsArray.filter(option =>
                    option.toLowerCase().includes(input)
                );
            },
        },
    ]);

    return selectedOption;
}

export async function converse(
    promptFile: string,
    responseFile: string,
    temperature: number,
    role: string,
    model: string
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
        const conversationHistory = await fs.readFile(responseFile, 'utf-8');
        const fullPrompt = conversationHistory + '\n\n' + prompt;

        if (!prompt.trim()) {
            console.log('Prompt was empty, aborting.');

            console.log(responseFile);

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

            return;
        }

        const deepInfra = createDeepInfra({apiKey: keys.getDeepSeekKey()});

        const res = await generateText({
            model: deepInfra(models[model]),
            prompt: fullPrompt,
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

        return await converse(promptFile, responseFile, temperature, role, model);
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}

export async function initializeChatFile(filePath: string): Promise<void> {
    const initialContent = `# AI Chat History\n\nThis file contains the conversation history between the user and AI.\n\n---\n\n`;
    await fs.writeFile(filePath, initialContent, 'utf-8');
}

export async function clearPromptFile(promptFile: string): Promise<void> {
    await fs.writeFile(promptFile, '', 'utf-8');
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

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}

function formatChatEntry(role: string, content: string): string {
    const timestamp = new Date().toISOString();
    return `### ${role} (${timestamp})\n\n${content}\n\n---\n\n`;
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
