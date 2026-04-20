import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import { aiRoles } from '@/AIchat/data/roles';
import * as conversation from '@/AIchat/main/agentConversation';
import { getAgentDefaultModel, getGithubToken } from '@/AIchat/utils/agentSettings';
import * as ui from '@/UI/generalUI';

function sortModels(models: ModelInfo[]): ModelInfo[] {
    return [...models].sort((left, right) => left.name.localeCompare(right.name));
}

async function pickCopilotModel(client: CopilotClient): Promise<string> {
    const models = sortModels(await client.listModels());
    const defaultModel = await getAgentDefaultModel();

    if (defaultModel && models.some((model) => model.id === defaultModel)) {
        return defaultModel;
    }

    const labelToModel = new Map<string, string>();
    const itemsArray = models.map((model) => {
        const disabled = model.policy?.state === 'disabled';
        const label = disabled
            ? `[DISABLED] ${model.name} (${model.id})`
            : `${model.name} (${model.id})`;
        labelToModel.set(label, model.id);

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

    return selectedModel;
}

export async function startAgentChat(): Promise<void> {
    const githubToken = getGithubToken();
    const client = new CopilotClient({
        ...(githubToken ? { githubToken } : {}),
        useLoggedInUser: !githubToken,
    });

    try {
        await client.start();

        const authStatus = await client.getAuthStatus();

        if (!authStatus.isAuthenticated && !githubToken) {
            throw new Error(authStatus.statusMessage || 'GitHub Copilot SDK authentication is not configured.');
        }

        const role = await ui.searchSelectAndReturnFromArray({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select an agent role',
        });
        const model = await pickCopilotModel(client);

        await conversation.converseAgent({ client, role, model });
    } catch (error) {
        await client.forceStop();
        throw error;
    }
}
