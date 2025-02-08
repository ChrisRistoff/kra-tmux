import * as fs from 'fs/promises';
import * as utils from '@AIchat/utils/aiUtils';
import * as ui from '@UI/generalUI'
import { aiRoles } from '../data/roles';
import { deepInfraModels, deepSeekModels, geminiModels, openAiModels } from '../data/models';
import path from 'path';

export async function startNewChat(): Promise<void> {
    try {
        const timestamp = Date.now();
        const tempDir = path.join('/tmp', `ai-chat-${timestamp}`);
        await fs.mkdir(tempDir, { recursive: true });

        const tempFiles = {
            promptFile: path.join(tempDir, 'prompt.md'),
            responseFile: path.join(tempDir, 'conversation.md')
        };

        await utils.initializeChatFile(tempFiles.responseFile);
        await utils.clearPromptFile(tempFiles.promptFile);

        const temperature = await utils.promptUserForTemperature();

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        const model = await ui.searchSelectAndReturnFromArray({
            itemsArray: [...Object.keys(deepInfraModels), ...Object.keys(geminiModels), ...Object.keys(openAiModels), ...Object.keys(deepSeekModels)],
            prompt: 'Select a model',
        })

        console.log('Opening vim for prompt...');
        await utils.converse(tempFiles.promptFile, tempFiles.responseFile, temperature, role, model);

        await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}
