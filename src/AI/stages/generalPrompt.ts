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

export async function generalPrompt(): Promise<void> {
    try {
        const tempFiles = await utils.createTempFiles();

        await fs.writeFile(tempFiles.promptFile, '');
        console.log('Opening vim for prompt...');

        await nvim.openNvimInTmuxAndWait(tempFiles.promptFile);
        console.log('Vim session completed');

        const prompt = await fs.readFile(tempFiles.promptFile, 'utf-8');

        if (!prompt.trim()) {
            console.log('Prompt was empty, aborting.');
            return;
        }

        const deepinfra = createDeepInfra({
            apiKey: keys.getDeepSeekKey(),
        });

        const temperature = await utils.promptUserForTemperature();

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        const res = await generateText({
            model: deepinfra(models.deepSeekR1),
            prompt,
            maxTokens: 4096,
            temperature: +temperature / 10,
            system: aiRoles[role] ? aiRoles[role] : '',
        });

        await fs.writeFile(tempFiles.responseFile, res.text);
        console.log(`Wrote response to: ${tempFiles.responseFile}`);

        await nvim.openNvimInTmuxAndWait(tempFiles.responseFile);

        await bash.execCommand('rm -rf /tmp/ai-prompt-*');

        console.log(res.text)
        console.log(res.usage)
    } catch (error) {
        console.error('Error in AI prompt workflow:', error);
        throw error;
    }
}
