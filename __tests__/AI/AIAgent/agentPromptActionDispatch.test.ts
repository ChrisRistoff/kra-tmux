import { dispatchPromptAction } from '@/AI/AIAgent/shared/main/agentPromptActionDispatch';
import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import * as conversation from '@/AI/shared/conversation';
import * as sessionEvents from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import * as memoryActions from '@/AI/AIAgent/shared/main/agentMemoryActions';

jest.mock('@/AI/shared/conversation', () => ({
    handleAddFileContext: jest.fn(),
    showFileContextsPopup: jest.fn(),
    handleRemoveFileContext: jest.fn(),
    clearAllFileContexts: jest.fn(),
}));

jest.mock('@/AI/AIAgent/shared/utils/agentSessionEvents', () => ({
    applyProposal: jest.fn(),
    openChangedProposalFile: jest.fn(),
    rejectCurrentProposal: jest.fn(),
    showProposalReview: jest.fn(),
    updateAgentUi: jest.fn(),
}));

jest.mock('@/AI/AIAgent/shared/main/agentMemoryActions', () => ({
    handleAddMemory: jest.fn(),
    handleDeleteMemory: jest.fn(),
    handleEditMemory: jest.fn(),
    handleSetMemoryStatus: jest.fn(),
    openMemoryBrowser: jest.fn(),
}));

function typed<T>(value: unknown): T {
    return value as T;
}

function makeState(): AgentConversationState {
    const nvimClient = typed<AgentConversationState['nvim']>({});
    const session = typed<AgentConversationState['session']>({
        abort: jest.fn(async () => undefined),
        executeTool: jest.fn(async () => 'tool ok'),
    });

    const state: AgentConversationState = {
        nvim: nvimClient,
        chatFile: '/tmp/chat.md',
        model: 'test-model',
        client: typed<AgentConversationState['client']>({}),
        session,
        cwd: '/tmp',
        history: typed<AgentConversationState['history']>({}),
        isStreaming: true,
        approvalMode: 'strict',
        allowedToolFamilies: new Set<string>(['bash']),
    };

    return state;
}

describe('dispatchPromptAction', () => {
    const mockedUpdateUi = jest.mocked(sessionEvents.updateAgentUi);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('stops active streaming turns and notifies the UI', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'stop_stream', []);

        expect(state.session.abort).toHaveBeenCalledTimes(1);
        expect(state.isStreaming).toBe(false);
        expect(mockedUpdateUi).toHaveBeenCalledWith(state.nvim, 'stop_turn', ['Stopped current agent turn']);
    });

    it('toggles approval mode and clears remembered tool approvals', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'toggle_yolo_mode', []);

        expect(state.approvalMode).toBe('yolo');
        expect(state.allowedToolFamilies.size).toBe(0);
        expect(mockedUpdateUi).toHaveBeenCalledWith(
            state.nvim,
            'show_error',
            ['Approval mode', 'YOLO mode enabled.']
        );
    });

    it('normalizes unsupported memory browser view values to all', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'browse_memory', [undefined, { view: 'unsupported-view' }]);

        expect(memoryActions.openMemoryBrowser).toHaveBeenCalledWith(state.nvim, 'all');
    });

    it('reports invalid execute_tool JSON payloads to the UI', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'execute_tool', [undefined, { title: 'kra:bash', args_json: '{bad json' }]);

        expect(mockedUpdateUi).toHaveBeenCalledWith(
            state.nvim,
            'show_tool_execution_result',
            ['', expect.stringContaining('Invalid JSON'), 'kra:bash']
        );
        expect(state.session.executeTool).not.toHaveBeenCalled();
    });

    it('runs execute_tool and returns result text when tool execution succeeds', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'execute_tool', [undefined, { title: 'kra:bash', args_json: '{"cmd":"pwd"}' }]);

        expect(state.session.executeTool).toHaveBeenCalledWith('kra:bash', { cmd: 'pwd' });
        expect(mockedUpdateUi).toHaveBeenCalledWith(
            state.nvim,
            'show_tool_execution_result',
            ['tool ok', '', 'kra:bash']
        );
    });

    it('routes file context actions through shared conversation handlers', async () => {
        const state = makeState();

        await dispatchPromptAction(state, 'add_file_context', []);
        await dispatchPromptAction(state, 'show_contexts_popup', []);
        await dispatchPromptAction(state, 'remove_file_context', []);
        await dispatchPromptAction(state, 'clear_contexts', []);

        expect(conversation.handleAddFileContext).toHaveBeenCalledWith(state.nvim, state.chatFile, { agentMode: true });
        expect(conversation.showFileContextsPopup).toHaveBeenCalledWith(state.nvim);
        expect(conversation.handleRemoveFileContext).toHaveBeenCalledWith(state.nvim);
        expect(conversation.clearAllFileContexts).toHaveBeenCalledWith(state.nvim);
    });
});
