/**
 * BYOK entry-point flow.
 *
 * 1. Pick a provider (filtered subset of AIChat's `providers` registry that
 *    speaks OpenAI-compatible Chat Completions and is suitable for tool use).
 * 2. Pick a model from that provider's registry.
 * 3. Resolve baseURL + API key from env (via byokProviders).
 * 4. Declare extra MCP servers (kra-bash + kra-web) via `additionalMcpServers`
 *    and hand off to the shared `converseAgent` runner.
 *
 * Adding/removing providers or models is done in `src/AI/AIChat/data/models.ts`
 * (registry) and `byokProviders.ts` (baseURL/key wiring) — same pattern as
 * AIChat, no duplication.
 */

import path from 'path';
import { providers as allProviders } from '@/AI/AIChat/data/models';
import * as conversation from '@/AI/AIAgent/shared/main/agentConversation';
import * as ui from '@/UI/generalUI';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import {
    SUPPORTED_BYOK_PROVIDERS,
    getProviderApiKey,
    getProviderBaseURL,
} from '@/AI/AIAgent/providers/byok/byokProviders';
import { OpenAICompatibleClient } from '@/AI/AIAgent/providers/byok/byokClient';

async function pickProvider(): Promise<string> {
    const available = SUPPORTED_BYOK_PROVIDERS.filter((p) => allProviders[p]);

    if (available.length === 0) {
        throw new Error('No BYOK-compatible providers found in src/AI/AIChat/data/models.ts');
    }

    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...available],
        prompt: 'Select a BYOK provider',
    });

    return selected;
}

async function pickModel(provider: string): Promise<string> {
    const models = allProviders[provider];

    if (!models) {
        throw new Error(`Provider '${provider}' has no model registry entry.`);
    }

    const labels = Object.keys(models);
    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray: labels,
        prompt: `Select a ${provider} model`,
    });

    const modelId = models[selectedLabel];

    if (!modelId) {
        throw new Error(`Model '${selectedLabel}' not found for provider '${provider}'.`);
    }

    return modelId;
}

function buildAdditionalMcpServers(): Record<string, MCPServerConfig> {
    const bashServerJs = path.join(__dirname, '..', '..', 'shared', 'utils', 'bashMcpServer.js');
    const webServerJs = path.join(__dirname, '..', '..', 'shared', 'utils', 'webMcpServer.js');

    return {
        'kra-bash': {
            type: 'stdio',
            command: process.execPath,
            args: [bashServerJs],
            tools: ['bash'],
        },
        'kra-web': {
            type: 'stdio',
            command: process.execPath,
            args: [webServerJs],
            tools: ['web_fetch', 'web_search'],
        },
    };
}

export async function startByokFlow(): Promise<void> {
    const provider = await pickProvider();
    const modelId = await pickModel(provider);
    const baseURL = getProviderBaseURL(provider);
    const apiKey = getProviderApiKey(provider);

    const client = new OpenAICompatibleClient({ baseURL, apiKey });

    try {
        await conversation.converseAgent({
            client,
            model: modelId,
            additionalMcpServers: buildAdditionalMcpServers(),
        });
    } catch (error) {
        await client.forceStop();
        throw error;
    }
}
