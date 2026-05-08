/**
 * OpenAI-compatible BYOK session.
 *
 * Implements `AgentSession` (the provider-neutral contract used by
 * `agentConversation.ts` and the rest of `shared/`). Wraps an OpenAI Chat
 * Completions client (any base URL), drives the streaming tool-call loop, and
 * fires the events the shared UI layer subscribes to.
 *
 * Design notes:
 *   - One session = one OpenAI client + one MCP client pool.
 *   - `send()` runs until the model produces a turn with no tool calls, then
 *     emits `session.idle` and returns.
 *   - Tool calls go through `onPreToolUse`/`onPostToolUse` hooks (same shape
 *     as Copilot SDK), then to the MCP client. Tool denials are surfaced to
 *     the model as the tool result so it can react.
 *   - Reasoning deltas (deepseek-reasoner et al.) are detected via
 *     `delta.reasoning_content` / `delta.reasoning` and routed to
 *     `assistant.reasoning_delta`.
 *   - On context-length errors we compact the history once and retry.
 */

import OpenAI from 'openai';
import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionMessageParam,
    ChatCompletionMessageFunctionToolCall,
    ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions/completions';
import type { Stream } from 'openai/streaming';
import {
    type AgentSendOptions,
    type AgentSession,
    type AgentSessionEventMap,
    type AgentSessionOptions,
    type LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { buildMcpClientPool, type McpClientPool } from '@/AI/AIAgent/providers/byok/mcpClientPool';
import { createExecutableToolBridge, disconnectPool } from '@/AI/AIAgent/mcp/executableToolBridge';
import { compactMessages, estimateTokens, isContextLengthError } from '@/AI/AIAgent/providers/byok/byokCompactor';
import { getFileContextsTaggedBlock } from '@/AI/shared/conversation';
import { getModelOverride, recordOverride } from '@/AI/AIAgent/providers/byok/byokOverrides';

const DEFAULT_SYSTEM_PROMPT = [
    'You are a coding agent.',
    'You may freely read, edit, and create files; the user reviews the resulting',
    'git diff at the end. Use the available tools — do not just describe what you',
    'would do.',
].join(' ');

export interface OpenAICompatibleSessionOptions {
    sessionOptions: AgentSessionOptions;
    baseURL: string;
    apiKey: string;
    /** Provider key (e.g. 'openrouter', 'deepseek') used to scope persisted overrides. */
    provider?: string;
}

interface InternalToolCall {
    id: string;
    name: string;
    args: string;
}

// ─── Text-based tool call extraction ─────────────────────────────────────────
//
// Some providers emit tool calls as special tokens in the content field instead
// of structured `tool_calls` deltas.  We detect these patterns and convert them
// into proper InternalToolCall objects.
//
// Pattern: <|tool_call_begin|>call_id<|tool_call_argument_begin|>{json}<|tool_call_end|>
// May be wrapped in <|tool_calls_section_begin|>...<|tool_calls_section_end|>

const TOOL_CALL_BEGIN = /<\|tool_call_begin\|>/g;
const TOOL_CALL_ARGUMENT_BEGIN = '<|tool_call_argument_begin|>';
const TOOL_CALL_END = '<|tool_call_end|>';

/**
 * Extract the function name from a Kimi-style tool call ID.
 * IDs follow the format `functions.tool_name:idx` (e.g. `functions.kra-file-context:search:0`).
 * The tool name itself may contain colons (namespaced MCP tools).
 */
function extractNameFromCallId(callId: string): string | undefined {
    // Match `functions.{anything}:{digits}` — the tool name is everything
    // between "functions." and the last ":{digits}".
    const match = callId.match(/^functions\.(.+):(\d+)$/);
    if (match) return match[1];

    return undefined;
}

/**
 * Resolve a tool name extracted from model output to the registered name.
 *
 * Models may output tool names in different formats:
 *   - `kra-file-context:search`  (colon-separated, as seen in system prompts)
 *   - `kra_file_context__search`  (double-underscore, the actual registered name)
 *
 * This function tries an exact match first, then falls back to normalising
 * hyphens to underscores and colons to double underscores.
 */
function resolveToolName(name: string, knownTools: ChatCompletionFunctionTool[]): string | undefined {
    // Exact match
    if (knownTools.some((t) => t.function.name === name)) return name;

    // Normalise: replace hyphens with underscores, colons with double underscores
    const normalised = name.replace(/-/g, '_').replace(/:/g, '__');
    if (knownTools.some((t) => t.function.name === normalised)) return normalised;

    return undefined;
}

/**
 * Extract tool calls from special-token patterns in the assistant content.
 * Handles both raw tokens and HTML-encoded variants (&lt;|…|&gt;).
 */
function extractTextToolCalls(rawText: string): InternalToolCall[] {
    // Normalise HTML-encoded tokens
    const text = rawText
        .replace(/&lt;\|/g, '<|')
        .replace(/\|&gt;/g, '|>');
    const calls: InternalToolCall[] = [];
    TOOL_CALL_BEGIN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = TOOL_CALL_BEGIN.exec(text)) !== null) {
        const startIdx = match.index + match[0].length;

        const argBeginIdx = text.indexOf(TOOL_CALL_ARGUMENT_BEGIN, startIdx);
        if (argBeginIdx === -1) break;

        const callId = text.slice(startIdx, argBeginIdx).trim();

        const endIdx = text.indexOf(TOOL_CALL_END, argBeginIdx);
        if (endIdx === -1) break;

        const argsStr = text.slice(
            argBeginIdx + TOOL_CALL_ARGUMENT_BEGIN.length,
            endIdx
        ).trim();

        let name = '';
        let args = '';
        try {
            const parsed = JSON.parse(argsStr);
            if (typeof parsed === 'object' && parsed !== null) {
                if (typeof parsed.name === 'string') {
                    name = parsed.name;
                    args = typeof parsed.arguments === 'string'
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments ?? {});
                } else {
                    args = JSON.stringify(parsed);
                }
            }
        } catch {
            args = argsStr;
        }

        // Fallback: extract name from the call ID (e.g. functions.kra-file-context:search:0)
        if (!name) {
            name = extractNameFromCallId(callId) ?? '';
        }

        if (name || args) {
            calls.push({
                id: callId || `call_${Date.now()}_${calls.length}`,
                name: name || '(unknown)',
                args: args || '{}',
            });
        }
    }

    return calls;
}

/**
 * Strip special-token tool call patterns from the assistant content.
 * Also strips section wrappers and handles HTML-encoded variants.
 */
function stripTextToolCalls(rawText: string): string {
    let text = rawText
        .replace(/&lt;\|/g, '<|')
        .replace(/\|&gt;/g, '|>');
    // Remove section wrappers first
    text = text.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '');
    // Remove individual tool call blocks
    text = text.replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
}

/**
 * When a provider claims to support tools but the model writes tool calls as
 * plain text (no special tokens, no structured deltas), we try to match known
 * tool names followed by JSON arguments in the content.
 *
 * Pattern: tool_name{"key": "value"} or tool_name\n{...}
 * The tool name must exactly match one of the provided tool definitions.
 */
function extractPlainTextToolCalls(
    text: string,
    knownTools: ChatCompletionFunctionTool[],
): InternalToolCall[] {
    if (knownTools.length === 0) return [];

    const calls: InternalToolCall[] = [];
    // Build a regex that matches any known tool name followed by JSON-like args
    const toolNames = knownTools.map((t) => t.function.name);
    // Escape special regex chars in tool names (e.g. dots, colons)
    const escapedNames = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(
        `(?<=^|\\s|\\n)(${escapedNames.join('|')})\\s*(\\{[\\s\\S]*?\\})`,
        'g'
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const argsStr = match[2];

        // Validate that argsStr is valid JSON
        let args = '{}';
        try {
            const parsed = JSON.parse(argsStr);
            args = typeof parsed === 'object' && parsed !== null
                ? JSON.stringify(parsed)
                : argsStr;
        } catch {
            // Not valid JSON — skip this match
            continue;
        }

        calls.push({
            id: `call_${Date.now()}_${calls.length}`,
            name,
            args,
        });
    }

    return calls;
}

/**
 * Strip plain-text tool calls from the assistant content so they don't appear
 * as regular text in the chat.
 */
function stripPlainTextToolCalls(
    text: string,
    knownTools: ChatCompletionFunctionTool[],
): string {
    if (knownTools.length === 0) return text;
    const toolNames = knownTools.map((t) => t.function.name);
    const escapedNames = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(
        `(?<=^|\\s|\\n)(${escapedNames.join('|')})\\s*(\\{[\\s\\S]*?\\})`,
        'g'
    );
    let result = text.replace(pattern, '');
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
}

type EventListener<K extends keyof AgentSessionEventMap> = (
    e: AgentSessionEventMap[K]
) => void;

// ─── Optional-parameter registry ─────────────────────────────────────────────
//
// Different OpenAI-compatible providers accept different subsets of optional
// chat-completion parameters.  Rather than hardcode three booleans + brittle
// keyword matching on 400 error messages, we describe each managed param as a
// `ParamSpec` in priority order (least-critical first).  When the provider
// rejects the request with 400, we strip the lowest-priority active param and
// retry — without trying to parse the error message at all.
//
// Phase 2 added the `dynamicParams` slot on AgentSessionOptions; Phase 3
// will generate descriptors from `ModelCapabilities.supportedParams`.

const MAX_STRIP_ITERATIONS = 16;

interface ParamContext {
    opts: AgentSessionOptions;
    openaiTools: ChatCompletionFunctionTool[];
    messages: ChatCompletionMessageParam[];
    stripped: ReadonlySet<string>;
}

interface ParamSpec {
    /** OpenAI API request body key. */
    key: string;
    /** Pull the value from session options / runtime context. */
    extract: (ctx: ParamContext) => unknown;
    /** Whether this param should currently be sent. */
    isActive: (ctx: ParamContext) => boolean;
    /** Other keys to strip together with this one (e.g. `tool_choice` with `tools`). */
    companions?: readonly string[];
    /** Returns a reason string to refuse auto-stripping; `undefined` to allow. */
    refuseStripReason?: (ctx: ParamContext) => string | undefined;
}

function hasAssistantToolCallsInHistory(messages: ChatCompletionMessageParam[]): boolean {
    return messages.some((m) => {
        if (m.role !== 'assistant') return false;
        const calls = (m as { tool_calls?: unknown[] }).tool_calls;

        return Array.isArray(calls) && calls.length > 0;
    });
}

const OPTIONAL_PARAMS: readonly ParamSpec[] = [
    {
        key: 'reasoning_effort',
        extract: (ctx) =>
            ctx.opts.dynamicParams?.['reasoning_effort']
            ?? ctx.opts.reasoningEffort,
        isActive: (ctx) =>
            !ctx.stripped.has('reasoning_effort')
            && (ctx.opts.dynamicParams?.['reasoning_effort'] != null
                || ctx.opts.reasoningEffort != null),
    },
    {
        key: 'temperature',
        extract: (ctx) =>
            ctx.opts.dynamicParams?.['temperature']
            ?? ctx.opts.temperature,
        isActive: (ctx) =>
            !ctx.stripped.has('temperature')
            && ctx.opts.modelCapabilities?.temperature !== false
            && (ctx.opts.dynamicParams?.['temperature'] != null
                || ctx.opts.temperature != null),
    },
    {
        // Decoupled from `tools` so providers that accept the schema but reject
        // `tool_choice: 'auto'` can recover without losing tool calling.
        key: 'tool_choice',
        extract: () => 'auto' as const,
        isActive: (ctx) =>
            !ctx.stripped.has('tool_choice')
            && !ctx.stripped.has('tools')
            && ctx.openaiTools.length > 0,
    },
    {
        key: 'tools',
        extract: (ctx) => ctx.openaiTools,
        isActive: (ctx) =>
            !ctx.stripped.has('tools')
            && ctx.openaiTools.length > 0,
        companions: ['tool_choice'],
        refuseStripReason: (ctx) =>
            hasAssistantToolCallsInHistory(ctx.messages)
                ? 'tools have already been used this turn — auto-stripping mid-conversation would invalidate prior tool_call messages; switch to a model that supports tools'
                : undefined,
    },
];

/**
 * Convert a non-streaming `ChatCompletion` response into a single-chunk async
 * iterable shaped like `Stream<ChatCompletionChunk>`. Used when the cached
 * provider override says streaming is buffered, so we save the SSE round-trip
 * while keeping the rest of `streamOnePass` (delta accumulation, tool-call
 * extraction, sniffer) untouched.
 */
function synthesizeStreamFromCompletion(completion: ChatCompletion): Stream<ChatCompletionChunk> {
    const choice = completion.choices[0];
    const msg = choice.message;
    const chunk: ChatCompletionChunk = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [
            {
                index: 0,
                delta: {
                    role: 'assistant',
                    content: typeof msg.content === 'string' ? msg.content : null,
                    ...(msg.tool_calls
                        ? {
                            tool_calls: msg.tool_calls
                                .filter((tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === 'function')
                                .map((tc, i) => ({
                                    index: i,
                                    id: tc.id,
                                    type: 'function' as const,
                                    function: { name: tc.function.name, arguments: tc.function.arguments },
                                })),
                        }
                        : {}),
                },
                finish_reason: choice.finish_reason ?? 'stop',
            },
        ],
    };

    async function* gen(): AsyncGenerator<ChatCompletionChunk> {
        yield chunk;
    }

    return gen() as unknown as Stream<ChatCompletionChunk>;
}

export class OpenAICompatibleSession implements AgentSession {
    private readonly openai: OpenAI;
    private readonly opts: AgentSessionOptions;
    private mcp: McpClientPool | undefined;
    private openaiTools: ChatCompletionFunctionTool[] = [];
    private messages: ChatCompletionMessageParam[] = [];
    private listeners: { [K in keyof AgentSessionEventMap]?: EventListener<K>[] } = {};
    private abortController: AbortController | undefined;
    private compactedThisTurn = false;
    /** OpenAI param keys we have been forced to drop after a 400 retry. */
    private strippedParams = new Set<string>();
    /** Hard cap on how many strip-and-retry iterations we'll perform per turn. */
    private stripIterations = 0;
    private readonly executableToolBridge = createExecutableToolBridge(() => this.mcp);
    private localTools: Map<string, LocalTool> = new Map();
    /** Provider key used to scope persisted overrides; undefined disables persistence. */
    private readonly provider: string | undefined;
    /** True when this model writes reasoning inline as <think>…</think> in delta.content. */
    private inlineReasoningTags = false;
    /** Sniffer state: are we currently inside a <think>…</think> block? */
    private insideThinkBlock = false;
    /** Sniffer state: leftover text that may be the start of a tag spanning chunks. */
    private inlineThinkBuffer = '';
    /** Cached `streamingMode` override from disk (`'non-streaming'` => provider buffers SSE). */
    private readonly cachedStreamingMode: 'streaming' | 'non-streaming' | undefined;

    public constructor(opts: OpenAICompatibleSessionOptions) {
        this.opts = opts.sessionOptions;
        this.openai = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
        this.provider = opts.provider;

        const override = getModelOverride(this.provider, this.opts.model);
        for (const key of override.strippedParams ?? []) {
            this.strippedParams.add(key);
        }
        if (override.inlineReasoningTags) {
            this.inlineReasoningTags = true;
        }
        this.cachedStreamingMode = override.streamingMode;
    }

    public getMessages(): ChatCompletionMessageParam[] {
        return [...this.messages];
    }

    public on: AgentSession['on'] = (event, handler) => {
        const list = (this.listeners[event] ??= []) as EventListener<typeof event>[];
        list.push(handler);
    };

    private emit<K extends keyof AgentSessionEventMap>(
        event: K,
        payload: AgentSessionEventMap[K]
    ): void {
        const list = this.listeners[event];

        if (!list) {
            return;
        }

        for (const handler of list) {
            try {
                handler(payload);
            } catch {
                // listener errors must not break the session loop
            }
        }
    }

    public async init(): Promise<void> {
        const mergedServers = {
            ...this.opts.mcpServers,
            ...(this.opts.additionalMcpServers ?? {}),
        };

        this.mcp = await buildMcpClientPool({
            servers: mergedServers,
            ...(this.opts.excludedTools ? { excludedTools: this.opts.excludedTools } : {}),
            ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
            workingDirectory: this.opts.workingDirectory,
        });

        const mcpOpenaiTools = this.mcp.openaiTools as ChatCompletionFunctionTool[];
        const localOpenaiTools: ChatCompletionFunctionTool[] = [];

        for (const localTool of this.opts.localTools ?? []) {
            if (this.mcp.tools.has(localTool.name)) {
                throw new Error(
                    `Local tool '${localTool.name}' collides with an MCP tool of the same name.`
                );
            }
            this.localTools.set(localTool.name, localTool);
            localOpenaiTools.push({
                type: 'function',
                function: {
                    name: localTool.name,
                    description: localTool.description,
                    parameters: localTool.parameters,
                },
            });
        }

        this.openaiTools = [...mcpOpenaiTools, ...localOpenaiTools];

        const sysContent = this.buildSystemMessage();
        this.messages.push({ role: 'system', content: sysContent });

        if (this.opts.initialMessages) {
            for (const msg of this.opts.initialMessages) {
                this.messages.push(msg);
            }
        }
    }

    private buildSystemMessage(): string {
        const sm = this.opts.systemMessage;

        if (!sm) {
            return DEFAULT_SYSTEM_PROMPT;
        }

        if (sm.mode === 'replace') {
            return sm.content;
        }

        return `${DEFAULT_SYSTEM_PROMPT}\n\n${sm.content}`;
    }

    private async maybeProactiveCompact(): Promise<void> {
        if (this.compactedThisTurn) {
            return;
        }

        const ctx = this.opts.contextWindow;

        if (!ctx || ctx <= 0) {
            return;
        }

        const thresholdEnv = Number(process.env['KRA_BYOK_COMPACT_THRESHOLD']);
        const threshold = Number.isFinite(thresholdEnv) && thresholdEnv > 0 && thresholdEnv < 1
            ? thresholdEnv
            : 0.70;

        const estimated = estimateTokens(this.messages);

        if (estimated < ctx * threshold) {
            return;
        }

        if (process.env['KRA_BYOK_DEBUG'] === '1') {
            console.error(`[byok] proactive compaction: ~${estimated} tokens > ${Math.round(ctx * threshold)} (${Math.round(threshold * 100)}% of ${ctx})`);
        }

        this.compactedThisTurn = true;
        this.messages = await compactMessages({
            openai: this.openai,
            model: this.opts.model,
            messages: this.messages,
        });
    }

    private buildParamContext(): ParamContext {
        return {
            opts: this.opts,
            openaiTools: this.openaiTools,
            messages: this.messages,
            stripped: this.strippedParams,
        };
    }

    /**
     * Produce the full ordered ParamSpec list for this session: static
     * `OPTIONAL_PARAMS` (highest strip-priority last, like `tools`) plus an
     * auto-generated spec for each `dynamicParams` key not already covered
     * by a static spec. Auto-generated specs are placed first so they get
     * stripped before any well-known param the user explicitly cares about.
     */
    private effectiveParamSpecs(): readonly ParamSpec[] {
        const dyn = this.opts.dynamicParams;
        if (!dyn) return OPTIONAL_PARAMS;
        const knownKeys = new Set(OPTIONAL_PARAMS.map((s) => s.key));
        const extras: ParamSpec[] = [];
        for (const key of Object.keys(dyn)) {
            if (knownKeys.has(key)) continue;
            if (dyn[key] == null) continue;
            extras.push({
                key,
                extract: (ctx) => ctx.opts.dynamicParams?.[key],
                isActive: (ctx) =>
                    !ctx.stripped.has(key)
                    && ctx.opts.dynamicParams?.[key] != null,
            });
        }
        if (extras.length === 0) return OPTIONAL_PARAMS;

        return [...extras, ...OPTIONAL_PARAMS];
    }

    /**
     * Inline-reasoning sniffer. Some models (open-source distillations, certain
     * proxies) emit chain-of-thought as `<think>…</think>` tags inside
     * `delta.content` instead of using the structured `reasoning_content` /
     * `reasoning_details` fields. This helper splits each chunk into reasoning
     * vs. message portions, emits the appropriate events, and returns the
     * message-only text so the caller can append it to `assistantText`.
     *
     * The state machine handles tags that span chunk boundaries by holding the
     * suspicious tail in `inlineThinkBuffer` until the next call.
     */
    private emitContentWithSniffer(text: string): string {
        const buf = this.inlineThinkBuffer + text;
        this.inlineThinkBuffer = '';

        let messageOut = '';
        let i = 0;
        while (i < buf.length) {
            if (this.insideThinkBlock) {
                const closeIdx = buf.indexOf('</think>', i);
                if (closeIdx === -1) {
                    // Possible partial '</think' at the tail — keep up to 7 chars buffered.
                    const keep = Math.min(7, buf.length - i);
                    const safeEnd = buf.length - keep;
                    if (safeEnd > i) {
                        const reasoning = buf.slice(i, safeEnd);
                        if (reasoning.length > 0) {
                            this.emit('assistant.reasoning_delta', { data: { deltaContent: reasoning } });
                        }
                    }
                    this.inlineThinkBuffer = buf.slice(safeEnd);

                    return messageOut;
                }
                if (closeIdx > i) {
                    this.emit('assistant.reasoning_delta', { data: { deltaContent: buf.slice(i, closeIdx) } });
                }
                this.insideThinkBlock = false;
                i = closeIdx + '</think>'.length;
            } else {
                const openIdx = buf.indexOf('<think>', i);
                if (openIdx === -1) {
                    // Possible partial '<think' at the tail — keep up to 6 chars buffered.
                    const keep = Math.min(6, buf.length - i);
                    const safeEnd = buf.length - keep;
                    if (safeEnd > i) {
                        messageOut += buf.slice(i, safeEnd);
                    }
                    this.inlineThinkBuffer = buf.slice(safeEnd);

                    return messageOut;
                }
                if (openIdx > i) {
                    messageOut += buf.slice(i, openIdx);
                }
                this.insideThinkBlock = true;
                i = openIdx + '<think>'.length;
                if (!this.inlineReasoningTags) {
                    this.inlineReasoningTags = true;
                    void recordOverride(this.provider, this.opts.model, { inlineReasoningTags: true });
                }
            }
        }
        if (messageOut.length > 0) {
            this.emit('assistant.message_delta', { data: { deltaContent: messageOut } });
        }

        return messageOut;
    }

    public send: AgentSession['send'] = async (options: AgentSendOptions) => {
        this.compactedThisTurn = false;
        this.abortController = new AbortController();

        // Sub-agents (investigator / executor) receive their own system prompt and
        // should not be polluted with the user's open-file context — that is an
        // orchestrator-only concern.
        const isSubAgent = this.opts.isSubAgent === true;
        let userContent: string;

        if (isSubAgent) {
            userContent = options.prompt;
        } else {
            const taggedFiles = await getFileContextsTaggedBlock();
            userContent = taggedFiles
                ? `${options.prompt}\n\n${taggedFiles}`
                : options.prompt;
        }

        this.messages.push({
            role: 'user',
            content: userContent,
        });

        try {
            await this.runTurnLoop();
        } finally {
            this.emit('session.idle', undefined);
        }
    };

    private async runTurnLoop(): Promise<void> {
        for (; ;) {
            const toolCalls = await this.streamOnePass();

            if (toolCalls.length === 0) {
                return;
            }

            for (const call of toolCalls) {
                await this.executeToolCall(call);

                if (this.abortController?.signal.aborted) {
                    return;
                }
            }
        }
    }

    /**
     * Extract tool calls that some models emit as text in the content field
     * instead of structured `tool_calls` deltas.
     *
     * Supported patterns:
     *   <|tool_call_begin|>call_id<|tool_call_argument_begin|>{json}<|tool_call_end|>
     *   May be wrapped in <|tool_calls_section_begin|>...<|tool_calls_section_end|>  (Kimi K2)
     */
    private async streamOnePass(): Promise<InternalToolCall[]> {
        await this.maybeProactiveCompact();

        let stream: Stream<ChatCompletionChunk>;

        try {
            const useNonStreaming = this.cachedStreamingMode === 'non-streaming';
            const createParams: Record<string, unknown> = {
                model: this.opts.model,
                messages: this.messages,
                stream: !useNonStreaming,
            };

            if (useNonStreaming && process.env.KRA_BYOK_DEBUG === '1') {
                process.stderr.write(
                    `[byok] cached streamingMode='non-streaming' for ${this.opts.model}: ` +
                    `requesting stream:false and synthesizing one chunk.\n`
                );
            }


            const paramCtx = this.buildParamContext();
            const effectiveSpecs = this.effectiveParamSpecs();
            for (const spec of effectiveSpecs) {
                if (spec.isActive(paramCtx)) {
                    createParams[spec.key] = spec.extract(paramCtx);
                }
            }

            if (useNonStreaming) {
                const completion = await this.openai.chat.completions.create(
                    createParams as unknown as Parameters<typeof this.openai.chat.completions.create>[0],
                    { signal: this.abortController?.signal }
                ) as ChatCompletion;
                stream = synthesizeStreamFromCompletion(completion);
            } else {
                stream = await this.openai.chat.completions.create(
                    createParams as unknown as Parameters<typeof this.openai.chat.completions.create>[0],
                    { signal: this.abortController?.signal }
                ) as Stream<ChatCompletionChunk>;
            }
        } catch (error) {
            if (!this.compactedThisTurn && isContextLengthError(error)) {
                this.compactedThisTurn = true;
                this.messages = await compactMessages({
                    openai: this.openai,
                    model: this.opts.model,
                    messages: this.messages,
                });

                return this.streamOnePass();
            }

            // Provide clearer error messages for common provider failures.
            if (error instanceof Error) {
                const status = (error as unknown as { status?: number }).status;
                if (status === 502 || status === 503) {
                    throw new Error(
                        `Provider returned ${status} (service unavailable). ` +
                        `The model may be overloaded or temporarily down. ` +
                        `Original: ${error.message}`
                    );
                }
                if (status === 400) {
                    // Generalised retry: find the lowest-priority active optional
                    // param, strip it (plus any companions), retry.  No error-
                    // message parsing — purely registry-driven.
                    if (this.stripIterations >= MAX_STRIP_ITERATIONS) {
                        throw new Error(
                            `Provider returned 400 (bad request) after ${this.stripIterations} ` +
                            `param-stripping retries. Original: ${error.message}`
                        );
                    }

                    const ctx = this.buildParamContext();
                    const next = this.effectiveParamSpecs().find((spec) => spec.isActive(ctx));

                    if (next) {
                        const refusal = next.refuseStripReason?.(ctx);
                        if (refusal) {
                            throw new Error(
                                `Provider returned 400, but auto-strip of '${next.key}' refused: ` +
                                `${refusal}. Original: ${error.message}`
                            );
                        }

                        this.strippedParams.add(next.key);
                        for (const companion of next.companions ?? []) {
                            this.strippedParams.add(companion);
                        }
                        this.stripIterations++;

                        this.emit('session.param_stripped', {
                            data: {
                                param: next.key,
                                companions: [...(next.companions ?? [])],
                                reason: error.message,
                            },
                        });

                        void recordOverride(this.provider, this.opts.model, {
                            strippedParams: [next.key, ...(next.companions ?? [])],
                        });


                        return this.streamOnePass();
                    }

                    throw new Error(
                        `Provider returned 400 (bad request). All non-essential parameters ` +
                        `already stripped. Original: ${error.message}`
                    );
                }
            }

            throw error;
        }

        const accumulatedToolCalls = new Map<number, InternalToolCall>();
        let assistantText = '';
        const debug = process.env.KRA_BYOK_DEBUG === '1';
        let chunkCount = 0;
        const streamStartedAt = Date.now();
        let firstChunkAt: number | undefined;
        let lastChunkAt: number | undefined;

        // Some providers reuse the same index for multiple parallel tool calls,
        // causing them to merge into one (e.g. "web_fetchweb_fetchweb_fetch").
        // Track the next synthetic index to assign when we detect a collision.
        let syntheticIndexCounter = 0;
        const idToIndex = new Map<string, number>();

        for await (const chunk of stream) {
            chunkCount += 1;
            if (firstChunkAt === undefined) {
                firstChunkAt = Date.now();
            }
            lastChunkAt = Date.now();


            // Some OpenAI-compatible providers send chunks with empty choices
            // (e.g. usage-only chunks). Guard against undefined choice / delta.
            const choice = chunk.choices[0];
            if (!choice) {
                continue;
            }
            const delta = choice.delta;
            if (!delta) {
                continue;
            }

            if (debug) {
                process.stderr.write(
                    `[byok] chunk #${chunkCount} content=${JSON.stringify(delta.content ?? null)} tool_calls=${delta.tool_calls?.length ?? 0} finish=${choice.finish_reason ?? ''}\n`
                );
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        process.stderr.write(
                            `[byok]   tc: index=${tc.index} id=${JSON.stringify(tc.id ?? null)} name=${JSON.stringify(tc.function?.name ?? null)} args_len=${tc.function?.arguments?.length ?? 0}\n`
                        );
                    }
                }
            }

            // Detect reasoning content based on the model's known interleaved field.
            // DeepSeek models use `reasoning_content`, some Google models use
            // `reasoning_details`, and others use the raw `reasoning` field.
            // The capability data from models.dev tells us which field to watch.
            const reasoningField = this.opts.modelCapabilities?.reasoningField;
            let reasoning: string | undefined;
            if (reasoningField === 'reasoning_content') {
                reasoning = (delta as unknown as { reasoning_content?: string }).reasoning_content;
            } else if (reasoningField === 'reasoning_details') {
                // reasoning_details is a structured object; extract text from it
                const details = (delta as unknown as { reasoning_details?: Array<{ type: string; text?: string }> }).reasoning_details;
                if (details) {
                    reasoning = details
                        .filter((d) => d.type === 'reasoning' && typeof d.text === 'string')
                        .map((d) => d.text!)
                        .join('');
                }
            } else {
                // Legacy fallback: try reasoning_content then reasoning
                reasoning =
                    (delta as unknown as { reasoning_content?: string }).reasoning_content ??
                    (delta as unknown as { reasoning?: string }).reasoning;
            }

            if (typeof reasoning === 'string' && reasoning.length > 0) {
                this.emit('assistant.reasoning_delta', { data: { deltaContent: reasoning } });
            }
            if (typeof delta.content === 'string' && delta.content.length > 0) {
                const useSniffer = !reasoningField
                    && (this.inlineReasoningTags
                        || this.insideThinkBlock
                        || this.inlineThinkBuffer.length > 0
                        || delta.content.includes('<think'));
                if (useSniffer) {
                    assistantText += this.emitContentWithSniffer(delta.content);
                } else {
                    assistantText += delta.content;
                    this.emit('assistant.message_delta', { data: { deltaContent: delta.content } });
                }
            }


            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    // Determine the effective index for this tool call.
                    // Well-behaved providers assign unique `index` values to each
                    // parallel tool call (0, 1, 2, …). Some providers reuse
                    // index 0 for all tool calls, causing them to merge into one
                    // (e.g. name becomes "web_fetchweb_fetchweb_fetch").
                    //
                    // When a delta carries `tc.id` (the start of a new tool call),
                    // we check if that id is already tracked. If not, and the
                    // provider-given index is already occupied by a *different*
                    // id, we assign a synthetic index to keep them separate.
                    let effectiveIndex: number;

                    if (tc.id) {
                        // This is the start of a new tool call (or a duplicate id).
                        const knownIndex = idToIndex.get(tc.id);
                        if (knownIndex !== undefined) {
                            // We've seen this id before — continue accumulating
                            // into the same slot.
                            effectiveIndex = knownIndex;
                        } else {
                            // New id. Check if the provider-given index is
                            // already taken by a different tool call.
                            const existing = accumulatedToolCalls.get(tc.index);
                            if (existing?.id && existing.id !== tc.id) {
                                // Index collision — assign a synthetic index.
                                effectiveIndex = 1000 + syntheticIndexCounter++;
                            } else {
                                effectiveIndex = tc.index;
                            }
                            idToIndex.set(tc.id, effectiveIndex);
                        }
                    } else {
                        // Continuation chunk (no id) — use the index mapping
                        // we established when the id first appeared.
                        const knownIndex = idToIndex.get(accumulatedToolCalls.get(tc.index)?.id ?? '');
                        effectiveIndex = knownIndex ?? tc.index;
                    }

                    const existing = accumulatedToolCalls.get(effectiveIndex) ?? {
                        id: '',
                        name: '',
                        args: '',
                    };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                    accumulatedToolCalls.set(effectiveIndex, existing);
                }
            }
        }

        if (debug) {
            process.stderr.write(
                `[byok] stream done: chunks=${chunkCount} text_len=${assistantText.length} tool_calls=${accumulatedToolCalls.size}\n`
            );

            for (const [idx, tc] of accumulatedToolCalls.entries()) {
                process.stderr.write(
                    `[byok]   tool_call[${idx}]: id=${JSON.stringify(tc.id)} name=${JSON.stringify(tc.name)} args_len=${tc.args.length}\n`
                );
            }
        }


        const toolCalls = Array.from(accumulatedToolCalls.values()).filter(
            (tc) => tc.id && tc.name
        );

        // Some providers emit tool calls as special tokens in the content field
        // instead of structured `tool_calls` deltas. Try to extract them.
        if (toolCalls.length === 0 && assistantText.length > 0) {
            const extracted = extractTextToolCalls(assistantText);
            if (extracted.length > 0) {
                if (debug) {
                    process.stderr.write(
                        `[byok] extracted ${extracted.length} text-based tool calls from content\n`
                    );
                }
                // Resolve extracted names to registered tool names (e.g.
                // `kra-file-context:search` → `kra_file_context__search`)
                for (const tc of extracted) {
                    const resolved = resolveToolName(tc.name, this.openaiTools);
                    if (resolved) tc.name = resolved;
                }
                toolCalls.push(...extracted);
                assistantText = stripTextToolCalls(assistantText);
            }
        }

        // Fallback: when the provider strips <|…|> tokens entirely but the model
        // still writes tool calls as plain text (e.g. `tool_name{"key": "val"}`).
        // Match known tool names followed by JSON arguments.
        if (toolCalls.length === 0 && assistantText.length > 0 && this.openaiTools.length > 0) {
            const plainExtracted = extractPlainTextToolCalls(assistantText, this.openaiTools);
            if (plainExtracted.length > 0) {
                if (debug) {
                    process.stderr.write(
                        `[byok] extracted ${plainExtracted.length} plain-text tool calls from content\n`
                    );
                }
                toolCalls.push(...plainExtracted);
                assistantText = stripPlainTextToolCalls(assistantText, this.openaiTools);
            }
        }

        const assistantMessage: ChatCompletionMessageParam = {
            role: 'assistant',
            content: assistantText || null,
            ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map<ChatCompletionMessageFunctionToolCall>((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.args || '{}' },
                    })),
                }
                : {}),
        };

        // Buffered-proxy detection: a long delay before the first chunk AND all
        // chunks arriving within a small burst window means the upstream provider
        // almost certainly buffered the full completion server-side and emitted it
        // as a tight cluster of SSE frames (rather than streaming in real time).
        // We persist the override + emit an event so a UI can warn and so future
        // sessions can switch to the non-streaming code path immediately.
        const ttfbMs = (firstChunkAt ?? Date.now()) - streamStartedAt;
        const burstMs = (lastChunkAt ?? firstChunkAt ?? streamStartedAt) - (firstChunkAt ?? streamStartedAt);
        const looksBuffered = ttfbMs >= 5000 && burstMs < 500;
        if (looksBuffered && this.cachedStreamingMode !== 'non-streaming') {
            this.emit('session.streaming_behavior_detected', {
                data: {
                    mode: 'non-streaming',
                    ttfbMs,
                    chunkCount,
                    inlineReasoningTags: this.inlineReasoningTags,
                },
            });
            void recordOverride(this.provider, this.opts.model, { streamingMode: 'non-streaming' });
            process.stderr.write(
                `[byok] detected buffered streaming for ${this.opts.model} ` +
                `(ttfb=${ttfbMs}ms, burst=${burstMs}ms, chunks=${chunkCount}); ` +
                `subsequent sessions will use non-streaming requests.\n`
            );
        }

        this.messages.push(assistantMessage);

        return toolCalls;
    }

    private async executeLocalToolCall(call: InternalToolCall, localTool: LocalTool): Promise<void> {
        const serverLabel = localTool.serverLabel ?? 'kra-local';

        let parsedArgs: unknown;

        try {
            parsedArgs = call.args ? JSON.parse(call.args) : {};
        } catch (error) {
            const msg = `Failed to parse tool arguments: ${(error as Error).message}`;
            this.emitToolStart(call, serverLabel, localTool.name);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const preHook = await this.opts.onPreToolUse({
            toolName: localTool.name,
            toolArgs: parsedArgs,
        });

        if (preHook.permissionDecision === 'deny') {
            const reason = preHook.permissionDecisionReason ?? 'Tool call denied by approval hook.';
            const msg = `Denied: ${reason}`;
            this.emitToolStart(call, serverLabel, localTool.name);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const finalArgs = preHook.modifiedArgs ?? parsedArgs;
        this.emitToolStart(call, serverLabel, localTool.name, finalArgs);

        let toolText: string;
        let isError = false;

        try {
            toolText = await localTool.handler(finalArgs as Record<string, unknown>);

            if (preHook.additionalContext) {
                toolText = `${preHook.additionalContext}\n\n${toolText}`;
            }

            const postHook = await this.opts.onPostToolUse({
                toolName: localTool.name,
                toolResult: { textResultForLlm: toolText },
            });

            if (postHook?.modifiedResult?.textResultForLlm) {
                toolText = postHook.modifiedResult.textResultForLlm;
            }
        } catch (error) {
            toolText = `Tool execution failed: ${(error as Error).message}`;
            isError = true;
        }

        this.appendToolResult(call.id, toolText);
        this.emitToolComplete(call, !isError, toolText);
    }

    private async executeToolCall(call: InternalToolCall): Promise<void> {
        const localTool = this.localTools.get(call.name);

        if (localTool) {
            await this.executeLocalToolCall(call, localTool);

            return;
        }

        // Resolve tool name: exact match → colon→double-underscore → suffix match
        // e.g. `kra-file-context:search` → `kra-file-context__search`
        // e.g. `recall` → `kra-memory__recall`
        let tool = this.mcp?.tools.get(call.name);
        if (!tool && call.name) {
            const colonNorm = call.name.replace(/:/g, '__');
            tool = this.mcp?.tools.get(colonNorm);
            if (tool) { call.name = colonNorm; }
            else {
                // Short name suffix match: `recall` → `kra-memory__recall`
                for (const [key, entry] of this.mcp?.tools ?? []) {
                    if (key.endsWith('__' + call.name)) {
                        call.name = key;
                        tool = entry;
                        break;
                    }
                }
            }
        }

        if (!tool) {
            this.emitToolStart(call, '(unknown)', '(unknown tool)');
            this.appendToolResult(call.id, `Tool '${call.name}' is not registered.`);
            this.emitToolComplete(call, false, `Tool '${call.name}' is not registered.`);

            return;
        }

        let parsedArgs: unknown;

        try {
            parsedArgs = call.args ? JSON.parse(call.args) : {};
        } catch (error) {
            const msg = `Failed to parse tool arguments: ${(error as Error).message}`;
            this.emitToolStart(call, tool.server, tool.originalName);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const preHook = await this.opts.onPreToolUse({
            toolName: tool.originalName,
            toolArgs: parsedArgs,
        });

        if (preHook.permissionDecision === 'deny') {
            const reason =
                preHook.permissionDecisionReason ?? 'Tool call denied by approval hook.';
            const msg = `Denied: ${reason}`;
            this.emitToolStart(call, tool.server, tool.originalName);
            this.appendToolResult(call.id, msg);
            this.emitToolComplete(call, false, msg);

            return;
        }

        const finalArgs = preHook.modifiedArgs ?? parsedArgs;

        this.emitToolStart(call, tool.server, tool.originalName, finalArgs);

        let toolText: string;
        let isError = false;

        try {
            const result = await tool.client.callTool({
                name: tool.originalName,
                arguments: finalArgs as Record<string, unknown>,
            });

            const contentArray = (result.content ?? []) as Array<{
                type: string;
                text?: string;
            }>;

            toolText = contentArray
                .filter((p) => p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text)
                .join('\n');

            isError = Boolean(result.isError);

            if (preHook.additionalContext) {
                toolText = `${preHook.additionalContext}\n\n${toolText}`;
            }

            const postHook = await this.opts.onPostToolUse({
                toolName: tool.originalName,
                toolResult: { textResultForLlm: toolText, raw: result },
            })

            if (postHook?.modifiedResult?.textResultForLlm) {
                toolText = postHook.modifiedResult.textResultForLlm;
            }
        } catch (error) {
            toolText = `Tool execution failed: ${(error as Error).message}`;
            isError = true;
        }

        this.appendToolResult(call.id, toolText);
        this.emitToolComplete(call, !isError, toolText);
    }

    private emitToolStart(
        call: InternalToolCall,
        mcpServerName: string,
        mcpToolName: string,
        args?: unknown
    ): void {
        let parsedArgs: unknown = args;

        if (parsedArgs === undefined) {
            try {
                parsedArgs = call.args ? JSON.parse(call.args) : {};
            } catch {
                parsedArgs = call.args;
            }
        }

        this.emit('tool.execution_start', {
            data: {
                toolCallId: call.id,
                toolName: mcpToolName,
                mcpServerName,
                mcpToolName,
                arguments: (parsedArgs ?? {}) as Record<string, unknown>,
            },
        });
    }

    private emitToolComplete(call: InternalToolCall, success: boolean, output: string): void {
        this.emit('tool.execution_complete', {
            data: {
                toolCallId: call.id,
                success,
                result: { content: output },
                ...(success ? {} : { error: output }),
            },
        });
    }

    private appendToolResult(toolCallId: string, content: string): void {
        this.messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content,
        });
    }

    public abort: AgentSession['abort'] = async () => {
        this.abortController?.abort();
    };

    public disconnect: AgentSession['disconnect'] = async () => {
        this.abortController?.abort();
        await disconnectPool(this.mcp);
    };

    public listExecutableTools: NonNullable<AgentSession['listExecutableTools']> = () => {
        return this.executableToolBridge.listExecutableTools();
    };

    public executeTool: NonNullable<AgentSession['executeTool']> = async (title, args) => {
        return this.executableToolBridge.executeTool(title, args);
    };
}

