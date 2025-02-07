import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as bash from '@utils/bashHelper';
import * as keys from '@AI/data/keys';
import * as nvim from '@/utils/neovimHelper';
import { aiHistoryPath } from '@/filePaths';
import { geminiModels, deepInfraModels, openAiModels, deepSeekModels } from '../data/models';
import * as ui from '@UI/generalUI'
import { aiRoles } from '../data/roles';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { generateText } from "ai";
import OpenAI from "openai";

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

        const response = await promptModel(model, fullPrompt, temperature, aiRoles[role]);

        const userEntry = formatChatEntry('User', prompt);
        const aiEntry = formatChatEntry('AI', response);

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

async function promptModel(model: string, prompt: string, temperature: number, system: string): Promise<string> {
    if (geminiModels[model]) {
        const genAI = new GoogleGenerativeAI(keys.getGeminiKey());
        const geminiModel = genAI.getGenerativeModel({ model: geminiModels[model] });

        const result = await geminiModel.generateContent(prompt);
        return result.response.text();
    }

    if (deepInfraModels[model]) {
        const deepInfra = createDeepInfra({apiKey: keys.getDeepInfraKey()});

        const res = await generateText({
            model: deepInfra(deepInfraModels[model]),
            prompt,
            maxTokens: 4096,
            temperature: temperature / 10,
            system,
        });

        return res.text;
    }

    if (deepSeekModels[model]) {
        const openai = new OpenAI({
            baseURL: 'https://api.deepseek.com',
            apiKey: keys.getDeepSeekKey(),
        });

        const completion = await openai.chat.completions.create({
            messages: [{ role: "system", content: prompt }],
            model: deepSeekModels[model],
        });

        return completion.choices[0].message.content!;
    }

    const openai = new OpenAI();
    const completion = await openai.chat.completions.create({
        model: openAiModels[model],
        messages: [
            { role: "system", content: system },
            {
                role: "user",
                content: prompt,
            },
        ],

        store: true,
    });

    return completion.choices[0].message.content!
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
