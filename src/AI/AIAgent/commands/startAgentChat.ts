import * as ui from '@/UI/generalUI';
import { startCopilotFlow } from '@/AI/AIAgent/providers/copilot';
import { startByokFlow } from '@/AI/AIAgent/providers/byok';

export async function startAgentChat(): Promise<void> {
    const provider = await ui.searchSelectAndReturnFromArray({
        itemsArray: ['copilot', 'byok'],
        prompt: 'Select agent provider',
    });

    if (provider === 'byok') {
        await startByokFlow();

        return;
    }

    await startCopilotFlow();
}
