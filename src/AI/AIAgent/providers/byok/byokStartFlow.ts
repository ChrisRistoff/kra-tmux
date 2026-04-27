/**
 * BYOK entry-point flow.
 *
 * 1. Pick a provider from the BYOK-supported set.
 *    via the shared modelCatalog and present a picker that surfaces context
 *    window and per-token pricing alongside each model.
 * 3. Resolve baseURL + API key (via the shared providers helper).
 * 4. Declare extra MCP servers (kra-bash + kra-web) via `additionalMcpServers`
 *    and hand off to the shared `converseAgent` runner, plumbing the chosen
 *    model's context window through so byokSession can compact proactively.
 *
 * Adding a new BYOK provider: extend `SUPPORTED_PROVIDERS` in
 * `src/AI/shared/data/providers.ts`, add a baseURL + key getter there, and
 * add a live fetcher branch in `src/AI/shared/data/modelCatalog.ts`.
 */

import * as conversation from '@/AI/AIAgent/shared/main/agentConversation';
import * as ui from '@/UI/generalUI';
import { buildByokExtraMcpServers } from '@/AI/AIAgent/mcp/serverConfig';
import {
    SUPPORTED_PROVIDERS,
    type SupportedProvider,
    getProviderApiKey,
    getProviderBaseURL,
} from '@/AI/shared/data/providers';
import { OpenAICompatibleClient } from '@/AI/AIAgent/providers/byok/byokClient';
import {
    type ModelInfo,
    formatModelInfoForPicker,
    getModelCatalog,
} from '@/AI/shared/data/modelCatalog';

async function pickProvider(): Promise<SupportedProvider> {
    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...SUPPORTED_PROVIDERS],
        prompt: 'Select a BYOK provider',
    });

    return selected as SupportedProvider;
}

async function pickModel(provider: SupportedProvider): Promise<ModelInfo> {
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
}


export async function startByokFlow(): Promise<void> {
    const provider = await pickProvider();
    const model = await pickModel(provider);
    const baseURL = getProviderBaseURL(provider);
    const apiKey = getProviderApiKey(provider);

    const client = new OpenAICompatibleClient({ baseURL, apiKey });

    try {
        await conversation.converseAgent({
            client,
            model: model.id,
            additionalMcpServers: buildByokExtraMcpServers(),
            ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
        });
    } catch (error) {
        await client.forceStop();
        throw error;
    }
}
