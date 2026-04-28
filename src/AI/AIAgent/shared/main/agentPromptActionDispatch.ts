import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import * as fileContext from '@/AI/shared/conversation';
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

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error';
}

export async function dispatchPromptAction(
    state: AgentConversationState,
    action: string,
    args: unknown[]
): Promise<void> {
    switch (action) {
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
            await fileContext.handleRemoveFileContext(state.nvim, state.chatFile, { agentMode: true });
            break;
        case 'clear_contexts':
            await fileContext.clearAllFileContexts(state.nvim, state.chatFile, { agentMode: true });
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
}
