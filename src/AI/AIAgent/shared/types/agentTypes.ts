import type * as neovim from 'neovim';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { AgentHistory, BashSnapshot } from '@/AI/AIAgent/shared/utils/agentHistory';

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
    'assistant.reasoning_delta': ReasoningDeltaEvent;
    'assistant.message_delta': MessageDeltaEvent;
    'tool.execution_start': ToolExecutionStartEvent;
    'tool.execution_progress': ToolExecutionProgressEvent;
    'tool.execution_partial_result': ToolExecutionPartialResultEvent;
    'tool.execution_complete': ToolExecutionCompleteEvent;
    'session.idle': void;
    'assistant.usage': AssistantUsageEvent;
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
    listExecutableTools?: () => Array<{ title: string; server: string; name: string }>;
    executeTool?: (title: string, args: Record<string, unknown>) => Promise<string>;
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
    /**
     * If set, restricts the tool inventory advertised to the model to the
     * given names. Tools are matched by trailing segment delimiter (`-`,
     * `__`, `.`) so bare names like `read_lines` match namespaced MCP tools
     * like `kra-file-context__read_lines`. Provider wrappers translate this
     * into whatever positive- or inverse-exclusion machinery they have.
     * Sub-agents use this to scope what the small model can even see.
     */
    allowedTools?: string[];
    /**
     * In-process tools registered alongside MCP tools. Useful for sub-agent
     * dispatch tools (e.g. `investigate`) where the handler must run in the
     * same Node process as the orchestrator session. They flow through the
     * normal pre/post-tool hooks just like MCP tools.
     */
    localTools?: LocalTool[];
    systemMessage?: { mode?: 'append' | 'replace'; content: string };
    contextWindow?: number;
    onPreToolUse: (input: AgentPreToolUseHookInput) => Promise<AgentPreToolUseHookOutput>;
    onPostToolUse: (input: AgentPostToolUseHookInput) => Promise<AgentPostToolUseHookOutput | void>;
    onUserInputRequest?: (request: AgentUserInputRequest) => Promise<AgentUserInputResponse>;
    /**
     * When true, this session is being used by a sub-agent (executor /
     * investigator) rather than the user-facing orchestrator. Provider
     * wrappers can use this to skip orchestrator-only knobs (e.g. skill
     * directories, turn-completion reminders, large context-management
     * thresholds).
     */
    isSubAgent?: boolean;
}

export interface LocalTool {
    /** Tool name as exposed to the model. Must not collide with any MCP tool name. */
    name: string;
    description: string;
    /** JSON Schema describing the tool's arguments (OpenAI function `parameters`). */
    parameters: Record<string, unknown>;
    /** Optional pseudo-server label used for telemetry / UI grouping. */
    serverLabel?: string;
    /** Handler invoked with the (possibly preToolUse-modified) arguments. Must return a string for the LLM. */
    handler: (args: Record<string, unknown>) => Promise<string>;
}

// ─── Conversation-level types ────────────────────────────────────────────────

export interface AgentConversationOptions {
    client: AgentClient;
    model: string;
    provider: string;
    additionalMcpServers?: Record<string, MCPServerConfig>;
    contextWindow?: number;
    executor?: import('@/AI/AIAgent/shared/subAgents/types').ExecutorRuntime;
    investigator?: import('@/AI/AIAgent/shared/subAgents/types').InvestigatorRuntime;
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
    cwd: string;
    history: AgentHistory;
    pendingBashSnapshot?: BashSnapshot;
    isStreaming: boolean;
    approvalMode: 'strict' | 'yolo';
    allowedToolFamilies: Set<string>;
    /**
     * The currently-running sub-agent session (investigator/executor), if any.
     * Tracked so that the user's `stop_stream` action can also abort sub-agents,
     * not just the orchestrator session.
     */
    activeSubAgentSession?: AgentSession | undefined;
    /**
     * Chronological log of the orchestrator's user messages, assistant
     * reasoning, and tool calls. Sliced and handed to the executor sub-agent
     * so it inherits the orchestrator's prior file reads and findings without
     * re-fetching them. See `orchestratorTranscript.ts`.
     */
    transcript: import('@/AI/AIAgent/shared/main/orchestratorTranscript').OrchestratorTranscript;
}

export interface ToolApprovalResult {
    action: 'allow' | 'deny' | 'allow-family' | 'yolo';
    modifiedArgs?: unknown;
}

// ─── Hook input/output (used by both providers and agentToolHook) ────────────

export interface AgentPreToolUseHookInput {
    toolName: string;
    toolArgs: unknown;
    /**
     * Optional label identifying which agent issued this tool call. When set,
     * the approval modal and chat output prefix the entry with `[<agentLabel>]`
     * so users can tell orchestrator vs sub-agent (e.g. INVESTIGATOR) tool calls
     * apart. Bulk-approve memory is keyed on tool name only, so allowances are
     * shared across agents.
     */
    agentLabel?: string;
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
    toolResult: { textResultForLlm: string;[key: string]: unknown };
    /** See AgentPreToolUseHookInput.agentLabel. */
    agentLabel?: string;
}

export interface AgentPostToolUseHookOutput {
    modifiedResult?: { textResultForLlm: string;[key: string]: unknown };
}

// ─── MessageOptions (replaces import from copilot-sdk in agentPromptActions) ─

export interface MessageOptions {
    prompt: string;
    attachments?: unknown[];
    mode?: 'immediate' | 'background';
}
