import * as ui from '@/UI/generalUI';
import { ChatModelDetails } from '@/AI/shared/types/aiTypes';
import { SUPPORTED_PROVIDERS } from '@/AI/shared/data/providers';
import { getModelCatalog, formatModelInfoForPicker, type ModelInfo } from '@/AI/shared/data/modelCatalog';
import { menuChain } from '@/UI/menuChain';

export async function promptUserForTemperature(model: string): Promise<number> {
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
    const result = await menuChain()
        .step('provider', async () => ui.searchSelectAndReturnFromArray({
            itemsArray: [...SUPPORTED_PROVIDERS],
            prompt: 'Select a provider',
        }))
        .step('model', async (d) => {
            const provider = d.provider as typeof SUPPORTED_PROVIDERS[number];
            const models = await getModelCatalog(provider);

            if (models.length === 0) {
                throw new Error(`No models returned for provider '${provider}'.`);
            }

            const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
            const labelToModel = new Map<string, ModelInfo>();

            for (const m of sorted) {
                labelToModel.set(formatModelInfoForPicker(m), m);
            }

            const selectedLabel = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...labelToModel.keys()],
                prompt: `Select a ${provider} model`,
            });

            const picked = labelToModel.get(selectedLabel);

            if (!picked) {
                throw new Error(`Model selection '${selectedLabel}' could not be resolved.`);
            }

            return picked;
        })
        .run();

    return {
        provider: result.provider,
        model: (result.model).id,
    };
}
