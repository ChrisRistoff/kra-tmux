import * as conversation from '@AIchat/utils/conversation';
import * as utils from '@AIchat/utils/aiUtils';
import * as ui from '@UI/generalUI';
import { aiRoles } from '../data/roles';
import { deepInfraModels, deepSeekModels, geminiModels, openAiModels, openRouter } from '../data/models';

export async function startNewChat(): Promise<void> {
    try {
        const timestamp = Date.now();

        const chatFile = `/tmp/ai-chat-${timestamp}.md`

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        const model = await ui.searchSelectAndReturnFromArray({
            itemsArray: [...Object.keys(deepInfraModels), ...Object.keys(geminiModels), ...Object.keys(openAiModels), ...Object.keys(deepSeekModels), ...Object.keys(openRouter)],
            prompt: 'Select a model',
        })

        const temperature = await utils.promptUserForTemperature(model);

        console.log('Opening vim for prompt...');
        await conversation.converse(chatFile, temperature, role, model);
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}
