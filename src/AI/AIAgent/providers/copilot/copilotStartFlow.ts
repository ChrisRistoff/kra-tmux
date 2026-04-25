import { type ModelInfo } from '@github/copilot-sdk';
import * as conversation from '@/AI/AIAgent/shared/main/agentConversation';
import { getAgentDefaultModel, getGithubToken } from '@/AI/AIAgent/shared/utils/agentSettings';
import * as ui from '@/UI/generalUI';
import type { ReasoningEffort } from '@/AI/AIAgent/shared/types/agentTypes';
import { CopilotClientWrapper } from '@/AI/AIAgent/providers/copilot/copilotClient';

interface PickedModel {
    modelId: string;
    reasoningEffort?: ReasoningEffort;
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
    return [...models].sort((left, right) => left.name.localeCompare(right.name));
}

function formatBillingMultiplier(model: ModelInfo): string {
    const multiplier = model.billing?.multiplier;

    if (!multiplier) {
        return '';
    }

    return ` [x${multiplier}]`;
}

async function pickReasoningEffort(model: ModelInfo): Promise<ReasoningEffort | undefined> {
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

async function pickCopilotModel(client: CopilotClientWrapper): Promise<PickedModel> {
    const models = sortModels(await client.listModels());
    const defaultModelId = await getAgentDefaultModel();

    if (defaultModelId && models.some((model) => model.id === defaultModelId)) {
        const defaultModel = models.find((m) => m.id === defaultModelId)!;
        const reasoningEffort = await pickReasoningEffort(defaultModel);

        return { modelId: defaultModelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
    }

    const labelToModel = new Map<string, ModelInfo>();
    const itemsArray = models.map((model) => {
        const disabled = model.policy?.state === 'disabled';
        const billing = formatBillingMultiplier(model);
        const label = disabled
            ? `[DISABLED] ${model.name} (${model.id})${billing}`
            : `${model.name} (${model.id})${billing}`;
        labelToModel.set(label, model);

        return label;
    });

    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: 'Select a Copilot model',
    });

    const selectedModel = labelToModel.get(selectedLabel);

    if (!selectedModel) {
        throw new Error('No Copilot model selected.');
    }

    const reasoningEffort = await pickReasoningEffort(selectedModel);

    return { modelId: selectedModel.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function startCopilotFlow(): Promise<void> {
    const githubToken = getGithubToken();
    const client = new CopilotClientWrapper({
        ...(githubToken ? { githubToken } : {}),
        useLoggedInUser: !githubToken,
    });

    try {
        await client.start();

        const authStatus = await client.getAuthStatus();

        if (!authStatus.isAuthenticated && !githubToken) {
            throw new Error(authStatus.statusMessage ?? 'GitHub Copilot SDK authentication is not configured.');
        }

        const { modelId, reasoningEffort } = await pickCopilotModel(client);
        client.setReasoningEffort(reasoningEffort);

        await conversation.converseAgent({
            client,
            model: modelId,
        });
    } catch (error) {
        await client.forceStop();
        throw error;
    }
}

