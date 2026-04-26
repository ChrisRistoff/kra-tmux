import * as fs from 'fs/promises';
import type { AgentConversationState, MessageOptions } from '@/AI/AIAgent/shared/types/agentTypes';
import {
    extractAgentDraftPrompt,
    formatAgentConversationEntry,
    isAgentDraftHeader,
    isAgentUserHeader,
    materializeAgentDraft,
} from '@/AI/AIAgent/shared/utils/agentUi';
import type { FileContext } from '@/AI/shared/types/aiTypes';
import * as aiNeovimHelper from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AI/shared/utils/conversationUtils/fileContexts';
import { appendToChat } from '@/AI/AIAgent/shared/utils/agentToolHook';
import {
    applyProposal,
    openChangedProposalFile,
    rejectCurrentProposal,
    showProposalReview,
    updateAgentUi,
} from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import {
    handleAddMemory,
    handleDeleteMemory,
    handleEditMemory,
    handleSetMemoryStatus,
    openMemoryBrowser,
} from '@/AI/AIAgent/shared/main/agentMemoryActions';

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error';
}

export function extractCurrentUserPrompt(lines: string[]): string {
    const draftPrompt = extractAgentDraftPrompt(lines);

    if (draftPrompt) {
        return draftPrompt;
    }

    let startIndex = -1;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isAgentUserHeader(lines[index])) {
            startIndex = index + 1;
            break;
        }
    }

    if (startIndex === -1) {
        return '';
    }

    return lines.slice(startIndex).join('\n').trim();
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

    const buffer = await state.nvim.buffer;
    const lines = await buffer.lines;
    const prompt = extractCurrentUserPrompt(lines);

    if (!prompt) {
        await state.nvim.command('echohl WarningMsg | echo "Type a prompt before submitting" | echohl None');

        return;
    }

    if (lines.some((line) => isAgentDraftHeader(line))) {
        await fs.writeFile(state.chatFile, materializeAgentDraft(lines), 'utf8');
        await state.nvim.command('edit!');
    }

    state.isStreaming = true;
    await updateAgentUi(state.nvim, 'start_turn', [state.model]);
    await appendToChat(state.chatFile, formatAgentConversationEntry('ASSISTANT', { model: state.model }));
    await aiNeovimHelper.updateNvimAndGoToLastLine(state.nvim);

    const attachments = await buildAttachments();

    await state.session.send({
        prompt,
        attachments,
        mode: 'immediate',
    });
}

export async function setupEventHandlers(state: AgentConversationState): Promise<void> {
    state.nvim.on('notification', (method, args) => {
        void (async (): Promise<void> => {
        if (method !== 'prompt_action') {
            return;
        }

        const action = args[0] as string;

        try {
            switch (action) {
                case 'submit_pressed':
                    await handleSubmit(state);
                    break;
                case 'add_file_context':
                    await fileContext.handleAddFileContext(state.nvim, state.chatFile, { agentMode: true });
                    break;
                case 'stop_stream':
                    await state.session.abort();
                    state.isStreaming = false;
                    await updateAgentUi(state.nvim, 'stop_turn', ['Stopped current agent turn']);
                    break;
                case 'show_contexts_popup':
                    await fileContext.showFileContextsPopup(state.nvim);
                    break;
                case 'remove_file_context':
                    await fileContext.handleRemoveFileContext(state.nvim);
                    break;
                case 'clear_contexts':
                    await fileContext.clearAllFileContexts(state.nvim);
                    break;
                case 'review_proposal':
                    await showProposalReview(state.nvim, state);
                    break;
                case 'open_proposal_file':
                    await openChangedProposalFile(state);
                    break;
                case 'apply_proposal':
                    await applyProposal(state);
                    break;
                case 'reject_proposal':
                    await rejectCurrentProposal(state);
                    break;
                case 'toggle_yolo_mode':
                    state.approvalMode = state.approvalMode === 'yolo' ? 'strict' : 'yolo';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(
                        state.nvim,
                        'show_error',
                        ['Approval mode', state.approvalMode === 'yolo' ? 'YOLO mode enabled.' : 'Strict approval mode enabled.']
                    );
                    break;
                case 'reset_tool_approvals':
                    state.approvalMode = 'strict';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(state.nvim, 'show_error', ['Approval mode', 'Reset remembered approvals.']);
                    break;
                case 'browse_memory': {
                    const params = (args[1] ?? {}) as { view?: unknown };
                    const v = String(params.view ?? 'all');
                    const view = v === 'findings' || v === 'revisits' ? v : 'all';
                    await openMemoryBrowser(state.nvim, view);
                    break;
                }
                case 'add_memory':
                    await handleAddMemory(state.nvim, (args[1] ?? {}) as Record<string, unknown>);
                    break;
                case 'delete_memory':
                    await handleDeleteMemory(state.nvim, (args[1] ?? {}) as Record<string, unknown>);
                    break;
                case 'edit_memory':
                    await handleEditMemory(state.nvim, (args[1] ?? {}) as Record<string, unknown>);
                    break;
                case 'set_memory_status':
                    await handleSetMemoryStatus(state.nvim, (args[1] ?? {}) as Record<string, unknown>);
                    break;
                case 'execute_tool': {
                    const payload = (args[1] ?? {}) as { title?: unknown; args_json?: unknown };
                    const title = String(payload.title ?? '');
                    const argsJson = String(payload.args_json ?? '{}');
                    if (!title) {
                        await updateAgentUi(state.nvim, 'show_tool_execution_result', ['', 'Missing tool title', '']);
                        break;
                    }
                    if (!state.session.executeTool) {
                        await updateAgentUi(state.nvim, 'show_tool_execution_result', ['', 'Tool re-execution not supported by current provider', title]);
                        break;
                    }
                    let parsedArgs: Record<string, unknown>;
                    try {
                        parsedArgs = JSON.parse(argsJson) as Record<string, unknown>;
                    } catch (err) {
                        await updateAgentUi(state.nvim, 'show_tool_execution_result', ['', `Invalid JSON: ${getErrorMessage(err)}`, title]);
                        break;
                    }
                    try {
                        const result = await state.session.executeTool(title, parsedArgs);
                        await updateAgentUi(state.nvim, 'show_tool_execution_result', [result, '', title]);
                    } catch (err) {
                        await updateAgentUi(state.nvim, 'show_tool_execution_result', ['', getErrorMessage(err), title]);
                    }
                    break;
                }
                default:
                    console.log('Unknown action:', action);
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
