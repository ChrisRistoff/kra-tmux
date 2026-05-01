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

        // When the caller asked for a positive tool inventory filter, translate
        // it into Copilot's `excludedTools` knob. Copilot accepts bare MCP tool
        // names there, so we enumerate the configured MCP servers, drop the
        // ones our whitelist matches, and merge the rest with whatever
        // `excludedTools` the caller already supplied.
        const mergedExcluded = await decideCopilotExcludedTools(options);

        const sdkSession = await this.inner.createSession({
            clientName: 'copilot-cli',
            model: options.model,
            ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
            workingDirectory: options.workingDirectory,
            streaming: true,
            enableConfigDiscovery: !isSubAgent,
            ...(isSubAgent ? {} : { skillDirectories: [skillsDir] }),
            mcpServers: options.mcpServers,
            ...(mergedExcluded.length > 0 ? { excludedTools: mergedExcluded } : {}),
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
