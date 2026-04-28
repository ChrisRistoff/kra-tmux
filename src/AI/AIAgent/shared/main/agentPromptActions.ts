import * as fs from 'fs/promises';
import type { AgentConversationState, MessageOptions } from '@/AI/AIAgent/shared/types/agentTypes';
import { formatSubmittedAgentPrompt } from '@/AI/AIAgent/shared/utils/agentUi';
import {
    formatAssistantHeader,
    materializeUserDraft,
} from '@/AI/shared/utils/conversationUtils/chatHeaders';
import type { FileContext } from '@/AI/shared/types/aiTypes';
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


async function createSelectionAttachment(
    context: FileContext,
    displayName: string
): Promise<{
    type: 'selection',
    filePath: string,
    displayName: string,
    selection: {
        start: { line: number, character: number },
        end: { line: number, character: number },
    },
    text: string,
}> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const allLines = content.split('\n');
    const startLine = context.startLine ?? 1;
    const endLine = context.endLine ?? startLine;
    const selectedText = allLines.slice(startLine - 1, endLine).join('\n');

    return {
        type: 'selection',
        filePath: context.filePath,
        displayName,
        selection: {
            start: { line: startLine - 1, character: 0 },
            end: { line: endLine - 1, character: allLines[endLine - 1]?.length ?? 0 },
        },
        text: selectedText,
    };
}

async function buildAttachments(): Promise<NonNullable<MessageOptions['attachments']>> {
    const attachments: NonNullable<MessageOptions['attachments']> = [];

    for (const context of fileContext.fileContexts) {
        const displayName = context.filePath.split('/').pop() ?? context.filePath;

        if (!context.isPartial) {
            attachments.push({
                type: 'file',
                path: context.filePath,
                displayName,
            });
            continue;
        }

        attachments.push(await createSelectionAttachment(context, displayName));
    }

    return attachments;
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

    const attachments = await buildAttachments();

    await state.session.send({
        prompt,
        attachments,
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
