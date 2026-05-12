import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import { formatSubmittedAgentPrompt } from '@/AI/AIAgent/shared/utils/agentUi';
import {
    formatAssistantHeader,
    materializeUserDraft,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
import { getAgentTurnHeaderRenderer } from './agentTurnHeaders';
import * as conversation from '@/AI/shared/conversation';
import { appendToChat } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
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


export async function handleSubmit(state: AgentConversationState, promptText: string): Promise<void> {
    if (state.isStreaming) {
        state.host.notify('Agent is still responding');

        return;
    }

    const prompt = promptText.trim();
    if (!prompt) {
        state.host.notify('Type a prompt before submitting');

        return;
    }

    const turnTimestamp = new Date().toISOString();

    await materializeUserDraft(state.chatFile, turnTimestamp);
    await appendToChat(state.chatFile, formatSubmittedAgentPrompt(prompt));

    // Render the user prompt header via the SHARED renderer so chat and
    // agent stay visually identical (and the previous turn's "USER (draft)"
    // banner gets rewound).
    const headers = getAgentTurnHeaderRenderer(state.host.app);
    headers.renderUserHeader(prompt, turnTimestamp);

    state.isStreaming = true;
    await updateAgentUi(state.host, 'start_turn', [state.model]);
    await appendToChat(state.chatFile, formatAssistantHeader(state.model, turnTimestamp));

    // Assistant header via the SHARED renderer (same styling chat uses).
    headers.renderAssistantHeader(state.model, turnTimestamp);

    const taggedFiles = await fileContext.getFileContextsTaggedBlock();
    const finalPrompt = taggedFiles ? `${prompt}\n\n${taggedFiles}` : prompt;

    state.transcript.appendUser(prompt);

    await state.session.send({
        prompt: finalPrompt,
        mode: 'immediate',
    });
}

export async function setupEventHandlers(state: AgentConversationState): Promise<void> {
    // Nvim-based prompt-action notifications are no longer used. Leader-key
    // actions are wired directly into the TUI app via
    // `wireAgentLeaderKeys` (see agentConversation.ts), and prompt submit
    // is routed through the TUI's `onSubmit` callback to `handleSubmit`.
    void state;
    void getErrorMessage;

    return Promise.resolve();
}
