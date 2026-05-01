import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import { formatSubmittedAgentPrompt } from '@/AI/AIAgent/shared/utils/agentUi';
import {
    formatAssistantHeader,
    materializeUserDraft,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
import {
    clearAgentPrompt,
    focusAgentPrompt,
    getAgentPromptText,
    refreshAgentLayout,
} from '@/AI/AIAgent/shared/main/agentNeovimSetup';
import * as conversation from '@/AI/shared/conversation';
import { appendToChat } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { dispatchPromptAction } from './agentPromptActionDispatch';
const fileContext = conversation;

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error';
}


async function handleSubmit(state: AgentConversationState): Promise<void> {
    if (state.isStreaming) {
        await state.nvim.command('echohl WarningMsg | echo "Agent is still responding" | echohl None');

        return;
    }

    const prompt = await getAgentPromptText(state.nvim);

    if (!prompt) {
        await state.nvim.command('echohl WarningMsg | echo "Type a prompt before submitting" | echohl None');

        return;
    }

    const turnTimestamp = new Date().toISOString();

    await materializeUserDraft(state.chatFile, turnTimestamp);
    await appendToChat(state.chatFile, formatSubmittedAgentPrompt(prompt));
    await clearAgentPrompt(state.nvim);

    state.isStreaming = true;
    await updateAgentUi(state.nvim, 'start_turn', [state.model]);
    await appendToChat(state.chatFile, formatAssistantHeader(state.model, turnTimestamp));
    await refreshAgentLayout(state.nvim);
    await focusAgentPrompt(state.nvim);

    const taggedFiles = await fileContext.getFileContextsTaggedBlock();
    const finalPrompt = taggedFiles ? `${prompt}\n\n${taggedFiles}` : prompt;

    await state.session.send({
        prompt: finalPrompt,
        mode: 'immediate',
    });
}

export async function setupEventHandlers(state: AgentConversationState): Promise<void> {
    state.nvim.on('notification', (method: string, args: unknown[]) => {
        void (async (): Promise<void> => {
        if (method !== 'prompt_action') {
            return;
        }

        const action = typeof args[0] === 'string' ? args[0] : '';

        try {
            if (action === 'submit_pressed') {
                await handleSubmit(state);
            } else {
                await dispatchPromptAction(state, action, args);
            }
        } catch (error) {
            await updateAgentUi(state.nvim, 'show_error', [
                `Action failed: ${action}`,
                getErrorMessage(error),
            ]);
        }
        })();
    });
}
