import path from 'path';
import { CopilotClient } from '@github/copilot-sdk';
import type {
    AgentClient,
    AgentSession,
    AgentSessionOptions,
    ReasoningEffort,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { TURN_REMINDER } from '@/AI/AIAgent/shared/main/turnReminder';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import { createExecutableToolBridge, disconnectPool } from '@/AI/AIAgent/mcp/executableToolBridge';
import { buildMcpClientPool, type McpClientPool } from '@/AI/AIAgent/providers/byok/mcpClientPool';
import { matchesSubAgentWhitelist } from '@/AI/AIAgent/shared/subAgents/whitelist';

export interface CopilotClientWrapperOptions {
    githubToken?: string;
    useLoggedInUser?: boolean;
    reasoningEffort?: ReasoningEffort;
}

async function decideCopilotExcludedTools(
    options: AgentSessionOptions
): Promise<string[]> {
    const baseExcluded = options.excludedTools ?? [];

    if (!options.allowedTools) {
        return baseExcluded;
    }

    const allowedSet = new Set(options.allowedTools);
    const merged = new Set<string>(baseExcluded);

    let probePool: McpClientPool | undefined;
    try {
        probePool = await buildMcpClientPool({
            servers: options.mcpServers,
            workingDirectory: options.workingDirectory,
        });

        for (const tool of probePool.tools.values()) {
            if (matchesSubAgentWhitelist(tool.namespacedName, allowedSet)) {
                continue;
            }
            // Copilot's excludedTools accepts the bare MCP tool name.
            merged.add(tool.originalName);
        }
    } catch {
        // If we can't enumerate, fall back to the caller-supplied excludes
        // only — the runtime denylist (if any) will still gate execution.
    } finally {
        if (probePool) {
            await probePool.disconnect();
        }
    }

    return Array.from(merged);
}

// Mirrors Copilot SDK's internal `TL()` sanitizer used to derive tool IDs from
// MCP client/server names. The SDK builds tool IDs as `${TL(clientName)}-${toolName}`
// (see CopilotClient.getToolIdFromClientAndToolName) and then `availableTools`
// is matched via exact `Array.includes`. So to whitelist an MCP tool we MUST
// use the same sanitized prefix the SDK will use internally.
function sanitizeMcpClientName(name: string): string {
    return name.replace(/@/g, '-').replace(/[^a-zA-Z0-9-_]/g, '-');
}

// For sub-agents on Copilot we use the SDK's `availableTools` whitelist
// instead of `excludedTools`. That hides built-in tools (read_bash, etc.)
// without us having to enumerate them. The catch: `availableTools` is matched
// by EXACT name against the IDs the SDK constructs for MCP tools, which are
// `${sanitizedClientName}-${toolName}` — NOT the bare tool name we store in
// our whitelist. So we have to enumerate the configured MCP servers, find the
// tools that match our bare-name whitelist, and translate them into Copilot's
// prefixed form before handing them to the SDK.
async function decideCopilotAvailableTools(
    options: AgentSessionOptions,
    localToolNames: string[]
): Promise<string[]> {
    const allowedSet = new Set(options.allowedTools ?? []);
    const result = new Set<string>(localToolNames);

    let probePool: McpClientPool | undefined;
    try {
        probePool = await buildMcpClientPool({
            servers: options.mcpServers,
            workingDirectory: options.workingDirectory,
        });

        for (const tool of probePool.tools.values()) {
            if (!matchesSubAgentWhitelist(tool.namespacedName, allowedSet)) {
                continue;
            }
            const copilotId = `${sanitizeMcpClientName(tool.server)}-${tool.originalName}`;
            result.add(copilotId);
        }
    } catch {
        // If enumeration fails we fall back to whatever the caller passed
        // (bare names + local tools). The sub-agent will be tool-starved
        // for MCP, but at least local tools (`submit_result`) keep working.
        for (const name of allowedSet) {
            result.add(name);
        }
    } finally {
        if (probePool) {
            await probePool.disconnect();
        }
    }

    return Array.from(result);
}

export class CopilotClientWrapper implements AgentClient {
    public readonly inner: CopilotClient;
    private reasoningEffort: ReasoningEffort | undefined;


    public constructor(options: CopilotClientWrapperOptions) {
        const init: ConstructorParameters<typeof CopilotClient>[0] = {
            useLoggedInUser: options.useLoggedInUser ?? !options.githubToken,
        };
        if (options.githubToken) {
            init.githubToken = options.githubToken;
        }
        this.inner = new CopilotClient(init);
        if (options.reasoningEffort) {
            this.reasoningEffort = options.reasoningEffort;
        }
    }

    public setReasoningEffort(effort: ReasoningEffort | undefined): void {
        this.reasoningEffort = effort;
    }


    public async start(): Promise<void> {
        await this.inner.start();
    }

    public async getAuthStatus(): ReturnType<CopilotClient['getAuthStatus']> {
        return this.inner.getAuthStatus();
    }

    public async listModels(): ReturnType<CopilotClient['listModels']> {
        return this.inner.listModels();
    }

    public async createSession(options: AgentSessionOptions): Promise<AgentSession> {
        const isSubAgent = options.isSubAgent === true;
        const skillsDir = path.join(__dirname, '..', '..', '..', '..', 'skills');

        const onPermissionRequest = (): { kind: 'approved' } => ({ kind: 'approved' as const });

        // For sub-agents, force a strict positive whitelist via the SDK's
        // `availableTools` knob. Per the SDK docs it "takes precedence over
        // excludedTools" and means ONLY listed tools are exposed to the
        // model — hiding ALL built-in Copilot tools (read_bash, write_bash,
        // stop_bash, list_bash, and any future additions) without us having
        // to enumerate every name we want to block. Local tools must be
        // listed by name to remain callable.
        let availableToolsForSdk: string[] | undefined;
        let mergedExcluded: string[] = options.excludedTools ?? [];

        if (isSubAgent && options.allowedTools && options.allowedTools.length > 0) {
            const localToolNames = options.localTools?.map((t) => t.name) ?? [];
            availableToolsForSdk = await decideCopilotAvailableTools(options, localToolNames);
        } else {
            // Orchestrator path: keep the existing enumerate-and-exclude
            // behaviour so any user-supplied excludes are honoured.
            mergedExcluded = await decideCopilotExcludedTools(options);
        }

        const sdkSession = await this.inner.createSession({
            clientName: 'copilot-cli',
            model: options.model,
            ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
            workingDirectory: options.workingDirectory,
            streaming: true,
            enableConfigDiscovery: !isSubAgent,
            ...(isSubAgent ? {} : { skillDirectories: [skillsDir] }),
            mcpServers: options.mcpServers,
            ...(availableToolsForSdk ? { availableTools: availableToolsForSdk } : {}),
            ...(mergedExcluded.length > 0 && !availableToolsForSdk ? { excludedTools: mergedExcluded } : {}),
            ...(options.localTools && options.localTools.length > 0 ? { tools: options.localTools } : {}),
            onPermissionRequest,
            infiniteSessions: {
                enabled: true,
                backgroundCompactionThreshold: 0.70,
                bufferExhaustionThreshold: 0.90,
            },
            hooks: {
                onPreToolUse: options.onPreToolUse,
                onPostToolUse: options.onPostToolUse,
                ...(isSubAgent ? {} : {
                    onUserPromptSubmitted: async () => ({
                        additionalContext: TURN_REMINDER,
                    }),
                }),
            },
            ...(options.onUserInputRequest ? { onUserInputRequest: options.onUserInputRequest } : {}),
            ...(options.systemMessage ? { systemMessage: options.systemMessage } : {}),
        } as unknown as Parameters<CopilotClient['createSession']>[0]);

        // Side channel MCP pool restricted to kra-* servers so the user can
        // re-execute our own tools from the agent UI even when the active
        // provider is Copilot (whose SDK does not expose its internal MCP
        // clients).
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
                // Side pool is best-effort; failure just disables re-execution.
                sidePool = undefined;
            }
        }

        const session = sdkSession as unknown as AgentSession;
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

        return session;
    }

    public async stop(): Promise<void> {
        await this.inner.stop();
    }

    public async forceStop(): Promise<void> {
        await this.inner.forceStop();
    }
}
