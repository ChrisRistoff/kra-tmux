import * as ui from '@/UI/generalUI';
import { ChatModelDetails } from '@/AI/shared/types/aiTypes';
import { SUPPORTED_PROVIDERS } from '@/AI/shared/data/providers';
import { getModelCatalog, formatModelInfoForPicker, type ModelInfo } from '@/AI/shared/data/modelCatalog';
import { getModelsDevCatalog, formatCapabilitiesSummary, type ModelsDevModelInfo } from '@/AI/shared/data/modelsDevCatalog';
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

            // Fetch capabilities from models.dev for the details panel
            let devModels: Map<string, ModelsDevModelInfo> = new Map();
            try {
                const catalog = await getModelsDevCatalog(provider);
                devModels = new Map(catalog.map((m) => [m.id, m]));
            } catch { /* non-fatal */ }

            const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
            const labelToModel = new Map<string, ModelInfo>();

            for (const m of sorted) {
                labelToModel.set(formatModelInfoForPicker(m), m);
            }

            // Build a details callback that shows capabilities from models.dev
            const detailsCallback = (item: string, _index: number): string => {
                const model = labelToModel.get(item);
                if (!model) return '';
                const devInfo = devModels.get(model.id);
                if (devInfo) {
                    return formatCapabilitiesSummary(devInfo);
                }
                // Fallback: show basic info from our catalog
                const lines: string[] = [];
                lines.push(`{bold}{cyan-fg}${model.label}{/cyan-fg}{/bold}`);
                lines.push('');
                if (model.contextWindow > 0) {
                    lines.push(`{bold}Context window:{/}  ${Math.round(model.contextWindow / 1000).toLocaleString()}k tokens`);
                }
                if (model.pricing) {
                    lines.push(`{bold}Pricing:{/}  $${model.pricing.inputPerM.toFixed(2)}/$${model.pricing.outputPerM.toFixed(2)} per 1M tokens`);
                    if (model.pricing.cachedInputPerM != null) {
                        lines.push(`  cached $${model.pricing.cachedInputPerM.toFixed(2)}`);
                    }
                }

                return lines.join('\n');
            };

            const selectedLabel = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...labelToModel.keys()],
                prompt: `Select a ${provider} model`,
                details: detailsCallback,
                detailsUseTags: true,
            });

            const picked = labelToModel.get(selectedLabel);

            if (!picked) {
                throw new Error(`Model selection '${selectedLabel}' could not be resolved.`);
            }

            // Enrich the model with capabilities from models.dev
            const devInfo = devModels.get(picked.id);
            if (devInfo) {
                picked.capabilities = devInfo.capabilities;
            }

            return picked;
        })
        .run();

    return {
        provider: result.provider,
        model: (result.model).id,
    };
}
