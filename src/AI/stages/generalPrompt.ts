import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { generateText } from "ai";
import * as keys from '@AI/data/keys';
import * as utils from '@AI/utils/aiUtils';
import * as nvim from '@/utils/neovimHelper';
import * as ui from '@UI/generalUI'
import { aiRoles } from '../data/roles';
import { models } from '../data/models';

async function converse(promptFile: string, responseFile: string, temperature: number, role: string): Promise<void> {
    try {
        await nvim.openNvimInTmuxAndWait(promptFile);
        console.log('Vim session completed');

        const prompt = await fs.readFile(promptFile, 'utf-8');

        if (!prompt.trim()) {
            console.log('Prompt was empty, aborting.');
            return;
        }

        const deepinfra = createDeepInfra({
            apiKey: keys.getDeepSeekKey(),
        });

        const res = await generateText({
            model: deepinfra(models.deepSeek70B),
            prompt,
            maxTokens: 4096,
            temperature: temperature / 10,
            system: aiRoles[role]? aiRoles[role] : '',
        });

        await fs.writeFile(responseFile, res.text);
        console.log(`Wrote response to: ${responseFile}`);

        await nvim.openNvimInTmuxAndWait(responseFile);

        return await converse(responseFile, promptFile, temperature, role);
    } catch (error) {
        console.error('Error in AI prompt workflow:', error);
        throw error;
    }
}

export async function generalPrompt(): Promise<void> {
    try {
        const tempFiles = await utils.createTempFiles();

        const temperature = await utils.promptUserForTemperature();

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        await fs.writeFile(tempFiles.promptFile, '');
        console.log('Opening vim for prompt...');

        await converse(tempFiles.promptFile, tempFiles.responseFile, temperature, role);

        await bash.execCommand('rm -rf /tmp/ai-prompt-*');
    } catch (error) {
        console.error('Error in AI prompt workflow:', error);
        throw error;
    }
}
