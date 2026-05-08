/**
 * Claude Agent SDK provider — client side.
 *
 * Mirrors the shape of `CopilotClientWrapper` so the picker can register
 * `kind: 'claude'` alongside `'copilot'` and `'byok'`. Translates the
 * repo's `AgentSessionOptions` into Claude SDK `Options`, builds in-process
 * MCP wrappers for `localTools`, and stitches a side-channel `kra-*` MCP
 * pool so `listExecutableTools`/`executeTool` keep working on the agent UI
 * even though the SDK doesn't expose its own MCP clients.
 *
 * SKELETON — see TODOs for the bits that need real wiring:
 *   - Hook input/output translation (Claude hook payloads ≠ repo's hook payloads).
 *   - LocalTool → SDK MCP server translation (sketched, needs Zod schemas).
 *   - Auth choice (subscription vs API key) — currently delegates entirely to
 *     whatever `claude login` was last used.
 */

import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
    createSdkMcpServer,
    tool,
    type Options as ClaudeSdkOptions,
    type PermissionMode,
    type EffortLevel,
    type AgentDefinition,
    type HookCallback,
    type SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { getModelsDevProviderModels } from '@/AI/shared/data/modelsDevCatalog';
import { z } from 'zod';
import type {
    AgentClient,
    AgentSession,
    AgentSessionOptions,
    LocalTool,
    ReasoningEffort,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentPostToolUseHookInput,
} from '@/AI/AIAgent/shared/types/agentTypes';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import { TURN_REMINDER } from '@/AI/AIAgent/shared/main/turnReminder';
import { createExecutableToolBridge, disconnectPool } from '@/AI/AIAgent/mcp/executableToolBridge';
import { buildMcpClientPool, type McpClientPool } from '@/AI/AIAgent/providers/byok/mcpClientPool';
import { ClaudeSessionBridge } from '@/AI/AIAgent/providers/claude/claudeSessionBridge';

export interface ClaudeModelInfo {
    id: string;
    name: string;
    supportedReasoningEfforts: ReasoningEffort[];
    contextWindow?: number;
    pricing?: { inputPerM: number; outputPerM: number; cachedInputPerM?: number };
}

export interface ClaudeClientOptions {
    /**
     * If true, the SDK uses whatever account `claude login` is configured
     * with (Pro/Max subscription, Console, Bedrock, Vertex, Foundry).
     * If false, set `ANTHROPIC_API_KEY` in the env before instantiating.
     */
    useLoggedInUser?: boolean;
    /**
     * Optional path to the `claude` CLI executable. Defaults to whatever the
     * SDK auto-detects on PATH.
     */
    pathToClaudeCodeExecutable?: string;
    reasoningEffort?: ReasoningEffort;
}

export class ClaudeClient implements AgentClient {
    /** Reserved for the picker's auth-mode UX; the SDK itself reads creds via the `claude` CLI. */
    public readonly useLoggedInUser: boolean;
    private readonly executablePath: string | undefined;
    private reasoningEffort: ReasoningEffort | undefined;
    private sessions: ClaudeSessionBridge[] = [];

    public constructor(options: ClaudeClientOptions = {}) {
        this.useLoggedInUser = options.useLoggedInUser ?? true;
        this.executablePath = options.pathToClaudeCodeExecutable;
        if (options.reasoningEffort) {
            this.reasoningEffort = options.reasoningEffort;
        }
    }

    public setReasoningEffort(effort: ReasoningEffort | undefined): void {
        this.reasoningEffort = effort;
    }

    public async createSession(options: AgentSessionOptions): Promise<AgentSession> {
        const isSubAgent = options.isSubAgent === true;
        const skillsDir = path.join(__dirname, '..', '..', '..', '..', 'skills');

        const allLocalTools = buildAllLocalTools(options);
        const localToolsServer = buildLocalToolsMcpServer(allLocalTools);
        const mcpServers = mergeMcpServers(options.mcpServers, localToolsServer);

        const permissionMode = decidePermissionMode(options);

        const sdkOptions: ClaudeSdkOptions = {
            cwd: options.workingDirectory,
            model: options.model,
            ...(mcpServers ? { mcpServers } : {}),
            // Disable ALL Claude built-in tools (Bash/Read/Write/Edit/Glob/
            // Grep/LS/TodoWrite/WebFetch/WebSearch/Task/MultiEdit/...). The
            // orchestrator exposes its own tools via LocalTool + the kra-*
            // MCP servers, so the model only ever sees ours.
            tools: [],
            permissionMode,
            ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
            ...(options.excludedTools && options.excludedTools.length > 0
                ? { disallowedTools: options.excludedTools }
                : {}),
            ...(options.allowedTools && options.allowedTools.length > 0
                ? { allowedTools: options.allowedTools }
                : {}),
            ...(this.reasoningEffort
                ? { effort: mapReasoningEffort(this.reasoningEffort) }
                : {}),
            ...(options.systemMessage
                ? buildSystemPrompt(options.systemMessage)
                : {}),
            ...(isSubAgent
                ? {}
                : {
                    settingSources: ['user', 'project', 'local'],
                }),
            // Note: Claude Agent SDK / CLI deliberately expose no
            // temperature, top-p, or sampling controls; the only model-
            // behavior dial is `--effort` (wired via reasoningEffort above).
            // `options.temperature` and `options.dynamicParams` from the
            // shared contract are intentionally ignored here.

            // Bridge the orchestrator's hook contracts onto the SDK's hook
            // shapes. The SDK uses snake_case payloads (`tool_name`,
            // `tool_input`, `tool_response`) and a JSON-output envelope
            // (`hookSpecificOutput`); we own a flatter camelCase shape. See
            // `adaptPreHook` / `adaptPostHook` below.
            hooks: {
                PreToolUse: [{ hooks: [adaptPreHook(options.onPreToolUse)] }],
                PostToolUse: [{ hooks: [adaptPostHook(options.onPostToolUse)] }],
                ...(isSubAgent ? {} : {
                    UserPromptSubmit: [{ hooks: [async (): Promise<SyncHookJSONOutput> => ({
                        continue: true,
                        hookSpecificOutput: {
                            hookEventName: 'UserPromptSubmit',
                            additionalContext: TURN_REMINDER,
                        },
                    })] }],
                }),
            },
        };

        // Side-channel MCP pool restricted to kra-* servers so the user can
        // re-execute our own tools from the agent UI even when the active
        // provider is Claude (whose SDK does not expose its internal MCP
        // clients). Same pattern as CopilotClientWrapper.
        const kraServers: Record<string, MCPServerConfig> = {};
        for (const [name, cfg] of Object.entries(options.mcpServers)) {
            if (name.startsWith('kra-')) {
                kraServers[name] = cfg;
            }
        }

        let sidePool: McpClientPool | undefined;
        if (Object.keys(kraServers).length > 0) {
            try {
                sidePool = await buildMcpClientPool({
                    servers: kraServers,
                    workingDirectory: options.workingDirectory,
                });
            } catch {
                sidePool = undefined;
            }
        }

        const session = new ClaudeSessionBridge({ sdkOptions });

        if (sidePool) {
            const bridge = createExecutableToolBridge(() => sidePool);
            session.listExecutableTools = bridge.listExecutableTools;
            session.executeTool = bridge.executeTool;
            const originalDisconnect = session.disconnect.bind(session);
            session.disconnect = async () => {
                await disconnectPool(sidePool, true);
                await originalDisconnect();
            };
        }

        // skillsDir is reserved for the same `skillDirectories` plumbing that
        // copilotClient.ts uses; the Claude SDK does not currently expose an
        // equivalent option, so we only consume it to silence unused-import.
        void skillsDir;

        this.sessions.push(session);

        return session;
    }

    /**
     * No-op for API parity with `CopilotClientWrapper.start()`. The Claude SDK
     * lazily spawns the `claude` CLI subprocess on the first `query()` call,
     * so there is nothing to start eagerly here.
     */
    public async start(): Promise<void> {
        return;
    }

    /**
     * Definitively probes Claude auth status by invoking the bundled binary's
     * `auth status` subcommand (which checks env / cached creds / Keychain in
     * one go). Falls back to a coarse ANTHROPIC_API_KEY check if the binary
     * isn't resolvable for some reason.
     */
    public getAuthStatus(): { isAuthenticated: boolean; statusMessage?: string } {
        if (process.env['ANTHROPIC_API_KEY']) {
            return { isAuthenticated: true };
        }

        const binary = this.executablePath ?? resolveBundledClaudeBinary();
        if (!binary) {
            return {
                isAuthenticated: false,
                statusMessage:
                    'Could not locate the bundled Claude binary. Reinstall '
                    + '`@anthropic-ai/claude-agent-sdk` (the per-platform '
                    + 'subpackage may be missing).',
            };
        }

        try {
            const out = execFileSync(binary, ['auth', 'status'], {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const parsed = JSON.parse(out) as { loggedIn?: boolean };
            if (parsed.loggedIn === true) {
                return { isAuthenticated: true };
            }
        } catch { /* binary missing or non-JSON output — treat as not authed */ }

        return {
            isAuthenticated: false,
            statusMessage:
                'Not logged in to Anthropic. The agent can run `claude auth '
                + 'login` for you (OAuth, supports Pro/Max), or you can set '
                + 'ANTHROPIC_API_KEY for Console pay-go billing.',
        };
    }

    /**
     * Spawns the bundled `claude auth login` flow with the user's TTY attached
     * so they can complete the browser-based OAuth handshake. Resolves once
     * the subprocess exits (regardless of success); call `getAuthStatus()`
     * afterwards to see whether it worked.
     */
    public async runInteractiveLogin(
        method: 'claudeai' | 'console' = 'claudeai',
    ): Promise<{ success: boolean; message?: string }> {
        const binary = this.executablePath ?? resolveBundledClaudeBinary();
        if (!binary) {
            return {
                success: false,
                message: 'Bundled Claude binary not found.',
            };
        }
        const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];

        return new Promise((resolve) => {
            const child = spawn(binary, args, { stdio: 'inherit' });
            child.on('error', (err) => resolve({ success: false, message: err.message }));
            child.on('exit', (code) => {
                const after = this.getAuthStatus();
                resolve(
                    after.isAuthenticated
                        ? { success: true }
                        : {
                            success: false,
                            ...(after.statusMessage
                                ? { message: after.statusMessage }
                                : code !== 0
                                    ? { message: `claude auth login exited with code ${code}` }
                                    : {}),
                        },
                );
            });
        });
    }


    /**
     * Pull the live Claude model catalog from models.dev. Falls back to a
     * small static list if the network call fails.
     */
    public async listModels(): Promise<ClaudeModelInfo[]> {
        try {
            const live = await getModelsDevProviderModels('anthropic');
            if (live.length > 0) {
                const modern = live
                    .filter((m) => /^claude-(sonnet|opus|haiku)-[4-9]/i.test(m.id))
                    .map((m) => ({
                        id: m.id,
                        name: m.name,
                        contextWindow: m.contextWindow,
                        ...(m.pricing ? { pricing: m.pricing } : {}),
                        supportedReasoningEfforts: ['low', 'medium', 'high'] as ReasoningEffort[],
                    }));

                const byBase = new Map<string, typeof modern[number]>();
                for (const m of modern) {
                    const base = m.id.replace(/-\d{8}$/, '');
                    const existing = byBase.get(base);
                    if (!existing || (existing.id.length > base.length && m.id === base)) {
                        byBase.set(base, m.id === base ? m : { ...m, id: base });
                    }
                }

                return Array.from(byBase.values()).sort((a, b) => a.name.localeCompare(b.name));
            }
        } catch { /* fall through to static list */ }

        return [
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
            { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', supportedReasoningEfforts: ['low', 'medium', 'high'] },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
        ];
    }

    public async stop(): Promise<void> {
        await Promise.allSettled(this.sessions.map(async (s) => s.disconnect()));
        this.sessions = [];
    }

    public async forceStop(): Promise<void> {
        await this.stop();
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function decidePermissionMode(options: AgentSessionOptions): PermissionMode {
    // The orchestrator gates approvals via Neovim UI before tool execution
    // reaches the model. From the SDK's perspective every tool call is
    // already pre-vetted, so we run with `bypassPermissions` for the
    // orchestrator. Sub-agents use `dontAsk` paired with allowedTools to
    // keep their inventory tight.
    if (options.isSubAgent && options.allowedTools && options.allowedTools.length > 0) {
        return 'dontAsk';
    }

    return 'bypassPermissions';
}

function mapReasoningEffort(effort: ReasoningEffort): EffortLevel {
    // ReasoningEffort already aligns with the SDK's EffortLevel union for
    // the levels we expose ('low' | 'medium' | 'high' | 'xhigh').
    return effort;
}

function buildSystemPrompt(
    message: NonNullable<AgentSessionOptions['systemMessage']>
): { systemPrompt: NonNullable<ClaudeSdkOptions['systemPrompt']> } {
    if (message.mode === 'append') {
        return {
            systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: message.content,
            },
        };
    }

    return { systemPrompt: message.content };
}

function buildLocalToolsMcpServer(
    localTools: LocalTool[] | undefined
): Record<string, ClaudeSdkOptions['mcpServers'] extends Record<string, infer V> | undefined ? V : never> {
    if (!localTools || localTools.length === 0) {
        return {};
    }

    // Wrap each LocalTool as a Zod-schema'd SDK MCP tool. The repo stores
    // tool parameters as raw JSON Schema objects; the SDK wants Zod. We
    // convert the schema per-tool so the model sees the real argument shape
    // (and so the SDK validates inputs) instead of a permissive
    // `z.record(z.unknown())` blob.
    const sdkTools = localTools.map((lt) => {
        const shape = jsonSchemaToZodShape(lt.parameters);

        return tool(
            lt.name,
            lt.description,
            shape,
            async (input: Record<string, unknown>) => {
                try {
                    const text = await lt.handler(input);

                    return { content: [{ type: 'text', text }] };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);

                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Tool '${lt.name}' threw: ${message}` }],
                    };
                }
            }
        );
    });

    const server = createSdkMcpServer({
        name: 'kra-local',
        version: '0.0.1',
        tools: sdkTools,
    });

    const result: ReturnType<typeof buildLocalToolsMcpServer> = { 'kra-local': server };

    return result;
}

function mergeMcpServers(
    repoServers: Record<string, MCPServerConfig>,
    extra: Record<string, unknown>
): ClaudeSdkOptions['mcpServers'] {
    // The repo's MCPServerConfig is a structural superset of what the SDK
    // accepts (command/args/env style stdio servers). Pass-through for now;
    // add explicit translation if we hit a config the SDK rejects.
    const merged: ClaudeSdkOptions['mcpServers'] = {
        ...(repoServers as unknown as ClaudeSdkOptions['mcpServers']),
        ...(extra as ClaudeSdkOptions['mcpServers']),
    };

    return merged;
}

// Reference an unused symbol to keep the AgentDefinition import alive — it's
// here so a future sub-agent registration helper has it ready to import from
// this module.
export type ClaudeAgentDefinition = AgentDefinition;

/**
 * Resolves the absolute path to the bundled Claude binary that ships inside
 * `@anthropic-ai/claude-agent-sdk`'s per-platform subpackage. Mirrors the
 * resolution logic the SDK itself uses internally so we hit the same binary
 * the SDK would spawn for a `query()` call.
 */
function resolveBundledClaudeBinary(): string | null {
    const platform = process.platform;
    const arch = process.arch;
    const ext = platform === 'win32' ? '.exe' : '';
    const candidates =
        platform === 'linux'
            ? [
                `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
                `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
            ]
            : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];

    for (const pkg of candidates) {
        try {
            return require.resolve(`${pkg}/claude${ext}`);
        } catch { /* try next */ }
    }

    return null;
}

// ─── Hook adapters ───────────────────────────────────────────────────────────
//
// The orchestrator passes flat camelCase callbacks (`AgentPreToolUseHookInput`/
// `AgentPostToolUseHookInput`). The Claude SDK calls hooks with snake_case
// inputs and expects a `SyncHookJSONOutput` envelope. These adapters bridge
// the two so byok/copilot/claude all funnel through the same orchestrator
// hooks (approval gating, sub-agent tool whitelists, audit logging).

function buildAllLocalTools(
    options: AgentSessionOptions
): LocalTool[] | undefined {
    const base = options.localTools ?? [];

    if (!options.onUserInputRequest) {
        return options.localTools;
    }

    // Synthesise an `ask_user` tool that calls the orchestrator's elicitation
    // hook. The Claude Agent SDK has no native primitive for asking the user
    // a clarifying question mid-turn, so we expose one as a normal tool the
    // model can call. Output is the user's plain-text answer.
    const askUser: LocalTool = {
        name: 'ask_user',
        description: 'Pause and ask the human user a clarifying question. Use this when you genuinely need information you cannot derive yourself. The user will see the question and reply; their reply is returned as the tool result.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The question to show the user.' },
                choices: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional pre-defined answer choices to offer.',
                },
                allowFreeform: {
                    type: 'boolean',
                    description: 'Whether the user may type a freeform reply in addition to choices. Default true.',
                },
            },
            required: ['question'],
        },
        handler: async (args) => {
            const onUserInputRequest = options.onUserInputRequest;

            if (!onUserInputRequest) {
                return 'Error: ask_user invoked but no input handler is registered.';
            }
            const response = await onUserInputRequest({
                question: args['question'],
                choices: args['choices'],
                allowFreeform: args['allowFreeform'],
            });

            return response.answer;
        },
    };

    return [...base, askUser];
}


function adaptPreHook(
    onPreToolUse: AgentSessionOptions['onPreToolUse'] | undefined
): HookCallback {
    return async (input): Promise<SyncHookJSONOutput> => {
        if (!onPreToolUse || input.hook_event_name !== 'PreToolUse') {
            return { continue: true };
        }
        const sdkInput = input;
        const repoInput: AgentPreToolUseHookInput = {
            toolName: sdkInput.tool_name,
            toolArgs: sdkInput.tool_input,
            ...(sdkInput.agent_type ? { agentLabel: sdkInput.agent_type } : {}),
        };
        const out: AgentPreToolUseHookOutput = await onPreToolUse(repoInput);

        const hookSpecificOutput: SyncHookJSONOutput['hookSpecificOutput'] = {
            hookEventName: 'PreToolUse',
            ...(out.permissionDecision ? { permissionDecision: out.permissionDecision } : {}),
            ...(out.permissionDecisionReason ? { permissionDecisionReason: out.permissionDecisionReason } : {}),
            ...(isPlainObject(out.modifiedArgs) ? { updatedInput: out.modifiedArgs } : {}),
            ...(out.additionalContext ? { additionalContext: out.additionalContext } : {}),
        };

        return {
            continue: out.permissionDecision !== 'deny',
            ...(out.suppressOutput ? { suppressOutput: true } : {}),
            hookSpecificOutput,
        };
    };
}

function adaptPostHook(
    onPostToolUse: AgentSessionOptions['onPostToolUse'] | undefined
): HookCallback {
    return async (input): Promise<SyncHookJSONOutput> => {
        if (!onPostToolUse || input.hook_event_name !== 'PostToolUse') {
            return { continue: true };
        }
        const sdkInput = input;
        const textResultForLlm = extractToolResponseText(sdkInput.tool_response);
        const repoInput: AgentPostToolUseHookInput = {
            toolName: sdkInput.tool_name,
            toolResult: { textResultForLlm, raw: sdkInput.tool_response },
            ...(sdkInput.agent_type ? { agentLabel: sdkInput.agent_type } : {}),
        };
        const out = await onPostToolUse(repoInput);
        if (!out || !out.modifiedResult) {
            return { continue: true };
        }

        return {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: out.modifiedResult.textResultForLlm,
            },
        };
    };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractToolResponseText(resp: unknown): string {
    // Claude SDK tool responses are usually `{ content: [{ type: 'text', text }] }`
    // (MCP-style) but can also be plain strings or other shapes for built-in
    // tools. Be defensive.
    if (typeof resp === 'string') return resp;
    if (resp && typeof resp === 'object') {
        const r = resp as Record<string, unknown>;
        if (Array.isArray(r['content'])) {
            const parts: string[] = [];
            for (const c of r['content'] as unknown[]) {
                if (c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text') {
                    const t = (c as Record<string, unknown>)['text'];
                    if (typeof t === 'string') parts.push(t);
                }
            }
            if (parts.length > 0) return parts.join('');
        }
        if (typeof r['text'] === 'string') return r['text'];
    }
    try {
        return JSON.stringify(resp);
    } catch {
        return String(resp);
    }
}

// ─── JSON Schema → Zod converter ────────────────────────────────────────────
//
// The Claude SDK's `tool()` helper requires a Zod raw shape (a flat record
// of Zod schemas). The repo stores tool parameters as JSON Schema. We
// convert the subset of JSON Schema actually used by the repo's LocalTools
// (string/number/boolean/array/object, with optional `enum` on strings).
// Anything outside that subset falls back to `z.unknown()` so the SDK still
// accepts the call and the LocalTool's own handler can validate.

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
    if (schema['type'] !== 'object' || !isPlainObject(schema['properties'])) {
        return { args: z.record(z.string(), z.unknown()).optional() };
    }
    const props = schema['properties'];
    const requiredArr = Array.isArray(schema['required'])
        ? (schema['required'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    const required = new Set<string>(requiredArr);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, raw] of Object.entries(props)) {
        if (!isPlainObject(raw)) continue;
        let s = jsonSchemaPropToZod(raw);
        if (typeof raw['description'] === 'string') {
            s = s.describe(raw['description']);
        }
        if (!required.has(key)) {
            s = s.optional();
        }
        shape[key] = s;
    }

    return shape;
}

function jsonSchemaPropToZod(prop: Record<string, unknown>): z.ZodTypeAny {
    const t = prop['type'];
    if (typeof t !== 'string') return z.unknown();
    switch (t) {
        case 'string': {
            const en = prop['enum'];
            if (Array.isArray(en) && en.length > 0 && en.every((v): v is string => typeof v === 'string')) {
                return z.enum(en as [string, ...string[]]);
            }

            return z.string();
        }
        case 'number':
        case 'integer':
            return z.number();
        case 'boolean':
            return z.boolean();
        case 'array': {
            const items = prop['items'];
            const inner = isPlainObject(items) ? jsonSchemaPropToZod(items) : z.unknown();

            return z.array(inner);
        }
        case 'object': {
            if (isPlainObject(prop['properties'])) {
                return z.object(jsonSchemaToZodShape(prop));
            }

            return z.record(z.string(), z.unknown());
        }
        default:
            return z.unknown();
    }
}
