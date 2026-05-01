/**
 * Shared agent provider + model picker.
 *
 * Used for the orchestrator AND for any sub-agent (executor / investigator).
 * The same UI code path is reused for every role so the user always sees the
 * same flow: pick BYOK or Copilot → (BYOK only) pick model provider → pick
 * model → (Copilot only) pick reasoning effort.
 *
 * The returned `client` is fully constructed; for Copilot it has been started
 * and auth-checked. The caller MUST keep a reference and call `forceStop` on
 * shutdown / error.
 */

import * as ui from '@/UI/generalUI';
import {
    SUPPORTED_PROVIDERS,
    type SupportedProvider,
    getProviderApiKey,
    getProviderBaseURL,
} from '@/AI/shared/data/providers';
import {
    type ModelInfo as ByokModelInfo,
    formatModelInfoForPicker,
    getModelCatalog,
} from '@/AI/shared/data/modelCatalog';
import { OpenAICompatibleClient } from '@/AI/AIAgent/providers/byok/byokClient';
import { CopilotClientWrapper } from '@/AI/AIAgent/providers/copilot/copilotClient';
import { getGithubToken } from '@/AI/AIAgent/shared/utils/agentSettings';
import { type ModelInfo as CopilotModelInfo } from '@github/copilot-sdk';
import type { AgentClient, ReasoningEffort } from '@/AI/AIAgent/shared/types/agentTypes';

const PROVIDER_KIND_BYOK = 'BYOK (OpenAI-compatible)';
const PROVIDER_KIND_COPILOT = 'GitHub Copilot';

export type AgentProviderKind = 'byok' | 'copilot';
export type AgentRole = 'orchestrator' | 'executor' | 'investigator';

export interface AgentRuntimePick {
    kind: AgentProviderKind;
    client: AgentClient;
    model: string;
    contextWindow?: number;
}

async function pickByokRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const provider = (await ui.searchSelectAndReturnFromArray({
        itemsArray: [...SUPPORTED_PROVIDERS],
        prompt: `Select a BYOK provider for the ${role}`,
    })) as SupportedProvider;

    const models = await getModelCatalog(provider);
    if (models.length === 0) {
        throw new Error(`No models returned for provider '${provider}'.`);
    }

    const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
    const labelToModel = new Map<string, ByokModelInfo>();
    for (const m of sorted) {
        labelToModel.set(formatModelInfoForPicker(m), m);
    }

    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...labelToModel.keys()],
        prompt: `Select a ${role} ${provider} model`,
    });
    const picked = labelToModel.get(selectedLabel);
    if (!picked) {
        throw new Error(`Model selection '${selectedLabel}' could not be resolved.`);
    }

    const client = new OpenAICompatibleClient({
        baseURL: getProviderBaseURL(provider),
        apiKey: getProviderApiKey(provider),
    });

    return {
        kind: 'byok',
        client,
        model: picked.id,
        ...(picked.contextWindow > 0 ? { contextWindow: picked.contextWindow } : {}),
    };
}

async function pickCopilotReasoningEffort(model: CopilotModelInfo): Promise<ReasoningEffort | undefined> {
    const supported = model.supportedReasoningEfforts;
    if (!supported?.length) {
        return undefined;
    }
    const defaultEffort = model.defaultReasoningEffort;
    const itemsArray = supported.map((effort) =>
        defaultEffort === effort ? `${effort} (default)` : effort
    );
    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: 'Select reasoning effort level',
    });

    return selected.replace(' (default)', '') as ReasoningEffort;
}

async function pickCopilotRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const githubToken = getGithubToken();
    const client = new CopilotClientWrapper({
        ...(githubToken ? { githubToken } : {}),
        useLoggedInUser: !githubToken,
    });

    await client.start();
    const authStatus = await client.getAuthStatus();
    if (!authStatus.isAuthenticated && !githubToken) {
        await client.forceStop();
        throw new Error(authStatus.statusMessage ?? 'GitHub Copilot SDK authentication is not configured.');
    }

    const models = [...(await client.listModels())].sort((a, b) =>
        a.name.localeCompare(b.name)
    );
    const labelToModel = new Map<string, CopilotModelInfo>();
    const itemsArray = models.map((m) => {
        const disabled = m.policy?.state === 'disabled';
        const billing = m.billing?.multiplier ? ` [x${m.billing.multiplier}]` : '';
        const label = disabled
            ? `[DISABLED] ${m.name} (${m.id})${billing}`
            : `${m.name} (${m.id})${billing}`;
        labelToModel.set(label, m);

        return label;
    });

    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: `Select a ${role} Copilot model`,
    });
    const selectedModel = labelToModel.get(selectedLabel);
    if (!selectedModel) {
        await client.forceStop();
        throw new Error('No Copilot model selected.');
    }

    const reasoningEffort = await pickCopilotReasoningEffort(selectedModel);
    client.setReasoningEffort(reasoningEffort);

    return {
        kind: 'copilot',
        client,
        model: selectedModel.id,
    };
}

export async function pickAgentRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const kind = await ui.searchSelectAndReturnFromArray({
        itemsArray: [PROVIDER_KIND_BYOK, PROVIDER_KIND_COPILOT],
        prompt: `Provider for the ${role}`,
    });

    if (kind === PROVIDER_KIND_COPILOT) {
        return pickCopilotRuntime(role);
    }

    return pickByokRuntime(role);
}