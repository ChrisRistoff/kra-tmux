import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as nvim from '@/utils/neovimHelper';
import { aiRoles } from '@AIchat/data/roles';
import { promptModel } from './promptModel';
import { saveChat } from './saveChat';

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
            return await saveChat(promptFile, responseFile, fullPrompt, temperature, role, model);
        }

        const response = await promptModel(model, fullPrompt, temperature, aiRoles[role]);

        const userEntry = formatChatEntry('User', prompt);
        const aiEntry = formatChatEntry(model, response);

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

export function formatChatEntry(role: string, content: string): string {
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

async function appendToChat(file: string, content: string): Promise<void> {
    await fs.appendFile(file, content, 'utf-8');
}
