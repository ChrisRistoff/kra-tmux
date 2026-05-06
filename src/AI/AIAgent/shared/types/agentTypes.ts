import type * as neovim from 'neovim';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
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
    'session.param_stripped': ParamStrippedEvent;
    'session.streaming_behavior_detected': StreamingBehaviorDetectedEvent;
};

export interface ParamStrippedEvent {
    data: {
        /** Primary OpenAI API parameter key that was dropped (e.g. 'temperature'). */
        param: string;
        /** Companion keys dropped together with `param` (e.g. ['tool_choice'] when stripping 'tools'). */
        companions: string[];
        /** Provider error message that triggered the strip. */
        reason: string;
    };
}

export interface StreamingBehaviorDetectedEvent {
    data: {
        /**
         * `'non-streaming'` when the provider silently buffered the entire
         * upstream response into a single SSE frame. `'streaming'` is reserved
         * for future re-detection if a provider regains streaming.
         */
        mode: 'streaming' | 'non-streaming';
        /** Milliseconds between request send and the first content/tool chunk. */
        ttfbMs: number;
        /** Total number of chunks observed across the response. */
        chunkCount: number;
        /**
         * `true` when the model emitted reasoning inline as `<think>…</think>`
         * tags inside `delta.content` instead of using a structured field.
         */
        inlineReasoningTags: boolean;
    };
}

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
    /**
     * Optional. Returns a copy of the current conversation messages array.
     * BYOK sessions implement this for session-continuation support;
     * Copilot SDK sessions do not (returns undefined).
     */
    getMessages?: () => ChatCompletionMessageParam[] | Promise<ChatCompletionMessageParam[]>;
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
    /**
     * Model capabilities fetched from models.dev. The BYOK session uses
     * this to know which streaming delta fields to watch for reasoning
     * content, whether to advertise tool calls, etc.
     */
    modelCapabilities?: import('@/AI/shared/data/modelCatalog').ModelCapabilities;
    /**
     * Reasoning effort level (BYOK only, for models that support it).
     * Maps to the `reasoning_effort` parameter in OpenAI-compatible APIs.
     */
    reasoningEffort?: 'low' | 'medium' | 'high';
    /**
     * Temperature override for BYOK sessions. When the model supports it,
     * this is passed directly to the chat completion API.
     */
    temperature?: number;
    /**
     * Generic per-(provider, model) optional parameters resolved by the picker
     * (Phase 2 of the BYOK parameter overhaul). Keyed by the OpenAI Chat
     * Completions API parameter name (e.g. `top_p`, `frequency_penalty`,
     * `parallel_tool_calls`). The BYOK session's `OPTIONAL_PARAMS` registry
     * checks this map first and falls back to the typed `reasoningEffort` /
     * `temperature` fields above for backward compatibility. Values are
     * passed through verbatim, so the picker is responsible for producing
     * API-shaped values.
     */
    dynamicParams?: Record<string, unknown>;
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
    /**
     * Optional. Messages to inject after the system prompt during init().
     * Used by executor session continuation — the stored conversation
     * (sans system message) is passed here so a fresh session picks up
     * where the previous one left off.
     */
    initialMessages?: ChatCompletionMessageParam[];
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
    /** Model capabilities from models.dev. Passed through to the BYOK session. */
    modelCapabilities?: import('@/AI/shared/data/modelCatalog').ModelCapabilities;
    /** Reasoning effort for BYOK models. Maps to `reasoning_effort` in the API. */
    reasoningEffort?: 'low' | 'medium' | 'high';
    /** Temperature override for BYOK sessions. */
    /** Temperature override for BYOK sessions. */
    temperature?: number;
    /**
     * Generic optional params resolved by the picker. See the matching field
     * on `AgentSessionOptions` for the full contract. Threaded straight
     * through to the session.
     */
    dynamicParams?: Record<string, unknown>;
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
    /** Optional free-form reason supplied by the user when explicitly denying. */
    denyReason?: string;
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
