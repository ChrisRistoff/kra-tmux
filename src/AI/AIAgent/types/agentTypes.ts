import type * as neovim from 'neovim';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import type { ProposalWorkspace } from '@/AI/AIAgent/utils/proposalWorkspace';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentConversationOptions {
    client: CopilotClient;
    role: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
}

export interface AgentUserInputResponse {
    answer: string;
    wasFreeform: boolean;
}

export interface AgentConversationState {
    chatFile: string;
    model: string;
    role: string;
    client: CopilotClient;
    session: CopilotSession;
    nvim: neovim.NeovimClient;
    proposalWorkspace: ProposalWorkspace;
    isStreaming: boolean;
    approvalMode: 'strict' | 'yolo';
    allowedToolFamilies: Set<string>;
}

export interface ToolApprovalResult {
    action: 'allow' | 'deny' | 'allow-family' | 'yolo';
    modifiedArgs?: unknown;
}

export interface AgentPreToolUseHookInput {
    toolName: string;
    toolArgs: unknown;
}

export interface ToolWritePreview {
    applyStrategy: 'content-field' | 'edit-tool';
    contentField?: 'content' | 'newContent';
    currentContent: string;
    diff: string;
    displayPath: string;
    note?: string;
    proposedContent: string;
    proposedEndsWithNewline: boolean;
}

export interface AgentPreToolUseHookOutput {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    modifiedArgs?: unknown;
    additionalContext?: string;
    suppressOutput?: boolean;
}
