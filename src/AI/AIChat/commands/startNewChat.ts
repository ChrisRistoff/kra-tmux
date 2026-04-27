import * as conversation from '@/AI/AIChat/main/conversation';
import * as utils from '@/AI/AIChat/utils/aiUtils';
import { aiRoles } from '@/AI/shared/data/roles';
import * as ui from '@/UI/generalUI';
import { menuChain } from '@/UI/menuChain';

export async function startNewChat(): Promise<void> {
    const timestamp = Date.now();
    const chatFile = `/tmp/ai-chat-${timestamp}.md`;

    const { role, pm, temperature } = await menuChain()
        .step('role', async () => ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: ',
        }))
        .step('pm', async () => utils.pickProviderAndModel())
        .step('temperature', async (d) => utils.promptUserForTemperature((d.pm).model))
        .run();

    console.log('Opening vim for prompt...');
    const { provider, model } = pm;
    await conversation.converse(chatFile, temperature, role, provider, model);
}
