import type * as neovim from 'neovim';
import type { ProposalWorkspace } from '@/AI/AIAgent/shared/utils/proposalWorkspace';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

// ─── Event payloads emitted by IAgentSession ─────────────────────────────────
// Shapes match what shared/utils/agentSessionEvents.ts already destructures.

export interface ReasoningDeltaEvent {
    data: { deltaContent: string };
}

export interface MessageDeltaEvent {
    data: { deltaContent: string };
}

export interface ToolExecutionStartEvent {
    data: {
        toolName: string;
        mcpServerName: string;
        mcpToolName: string;
        toolCallId: string;
        arguments: Record<string, unknown>;
    };
}

export interface ToolExecutionProgressEvent {
    data: { toolCallId: string; progressMessage: string };
}

export interface ToolExecutionPartialResultEvent {
    data: { toolCallId: string; partialOutput: string };

}

export interface ToolResultSummary {
    content: string;
    detailedContent?: string;
}

export interface ToolExecutionCompleteEvent {
    data: {
        toolCallId: string;
        success: boolean;
        result?: ToolResultSummary;
        error?: string;
    };
}

export interface AssistantUsageEvent {
    data: {
        quotaSnapshots?: Record<string, {
            remainingPercentage: number;
            resetDate?: string;
            isUnlimitedEntitlement: boolean;
        }>;
    };
}

export type AgentSessionEventMap = {
    'assistant.reasoning_delta':       ReasoningDeltaEvent;
    'assistant.message_delta':         MessageDeltaEvent;
    'tool.execution_start':            ToolExecutionStartEvent;
    'tool.execution_progress':         ToolExecutionProgressEvent;
    'tool.execution_partial_result':   ToolExecutionPartialResultEvent;
    'tool.execution_complete':         ToolExecutionCompleteEvent;
    'session.idle':                    void;
    'assistant.usage':                 AssistantUsageEvent;
};

// ─── Provider-neutral session/client interfaces ──────────────────────────────

export interface AgentSendOptions {
    prompt: string;
    attachments?: unknown[];
    mode?: 'immediate' | 'background';
}

export interface AgentSession {
    on: <K extends keyof AgentSessionEventMap>(
        event: K,
        handler: (e: AgentSessionEventMap[K]) => void
    ) => void;
    send: (options: AgentSendOptions) => Promise<void>;
    abort: () => Promise<void>;
    disconnect: () => Promise<void>;
}


export interface AgentClient {
    createSession: (options: AgentSessionOptions) => Promise<AgentSession>;
    stop: () => Promise<void>;
    forceStop?: () => Promise<void>;
}

export interface AgentUserInputRequest {
    // Keep loose; the only consumer is handleAgentUserInput which accepts unknown.
    [key: string]: unknown;
}

export interface AgentSessionOptions {
    model: string;
    workingDirectory: string;
    mcpServers: Record<string, MCPServerConfig>;
    additionalMcpServers?: Record<string, MCPServerConfig>;
    excludedTools?: string[];
    systemMessage?: { mode?: 'append' | 'replace'; content: string };
    onPreToolUse: (input: AgentPreToolUseHookInput) => Promise<AgentPreToolUseHookOutput>;
    onPostToolUse: (input: AgentPostToolUseHookInput) => Promise<AgentPostToolUseHookOutput | void>;
    onUserInputRequest?: (request: AgentUserInputRequest) => Promise<AgentUserInputResponse>;
}

// ─── Conversation-level types ────────────────────────────────────────────────

export interface AgentConversationOptions {
    client: AgentClient;
    model: string;
    additionalMcpServers?: Record<string, MCPServerConfig>;
}


export interface AgentUserInputResponse {
    answer: string;
    wasFreeform: boolean;
}

export interface AgentConversationState {
    chatFile: string;
    model: string;
    client: AgentClient;
    session: AgentSession;
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

// ─── Hook input/output (used by both providers and agentToolHook) ────────────

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

export interface AgentPostToolUseHookInput {
    toolName: string;
    toolResult: { textResultForLlm: string; [key: string]: unknown };
}

export interface AgentPostToolUseHookOutput {
    modifiedResult?: { textResultForLlm: string; [key: string]: unknown };
}

// ─── MessageOptions (replaces import from copilot-sdk in agentPromptActions) ─

export interface MessageOptions {
    prompt: string;
    attachments?: unknown[];
    mode?: 'immediate' | 'background';
}
