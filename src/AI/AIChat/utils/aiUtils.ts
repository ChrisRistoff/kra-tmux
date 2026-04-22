import * as ui from '@/UI/generalUI';
import { ChatModelDetails } from '@/AI/shared/types/aiTypes';
import { providers } from '@/AI/AIChat/data/models';

export async function promptUserForTemperature(model: string) {
    const maxTemp = model.startsWith('gemini') ? 20 : 10;
    const optionsArray: string[] = [];

    for (let i = 0; i <= maxTemp; i++) {
        optionsArray.push(i.toString());
    }

    const temperature = await ui.searchAndSelect({
        prompt: 'Select temperature',
        itemsArray: optionsArray,
    });

    return +temperature / 10;
}

export function formatChatEntry(role: string, content: string, topLevel = false): string {
    const timestamp = new Date().toISOString();
    let header = `\n---\n### ${role} (${timestamp})\n\n`;

    if (topLevel) {
        header = `### ${role} (${timestamp})\n\n`;
    }

    return content ? `${header}${content}\n---\n` : header;
}

export async function pickProviderAndModel(): Promise<ChatModelDetails> {
    const provider = await ui.searchSelectAndReturnFromArray({
        itemsArray: Object.keys(providers),
        prompt: 'Select a provider',
    });

    const model = await ui.searchSelectAndReturnFromArray({
        itemsArray: Object.keys(providers[provider]),
        prompt: 'Select a model',
    });

    return {
        provider,
        model: providers[provider][model]
    }
}
