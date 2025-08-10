import * as conversation from '@/AIchat/utils/conversation';
import * as utils from '@/AIchat/utils/aiUtils';
import { aiRoles } from '@/AIchat/data/roles';
import * as ui from '@/UI/generalUI';

export async function startNewChat(): Promise<void> {
    try {
        const timestamp = Date.now();

        const chatFile = `/tmp/ai-chat-${timestamp}.md`

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        const { provider, model } = await utils.pickProviderAndModel();

        const temperature = await utils.promptUserForTemperature(model);

        console.log('Opening vim for prompt...');
        await conversation.converse(chatFile, temperature, role, provider, model);
    } catch (error) {
        console.error('Error in AI prompt workflow:', (error as Error).message);
        throw error;
    }
}
