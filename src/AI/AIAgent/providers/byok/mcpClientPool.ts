/**
 * MCP client pool for BYOK sessions.
 *
 * Spawns each configured local MCP server (via @modelcontextprotocol/sdk's
 * StdioClientTransport), lists its tools, then DISCONNECTS the transport.
 * Subsequent `callTool` invocations transparently re-spawn the server on
 * demand and shut it back down after a configurable idle window.
 *
 * Why on-demand: the kra-* MCP servers (file-context, memory, bash, web,
 * session-complete) collectively hold ~300 MB of resident node + native
 * heap (plus any LSP children file-context spawns), even when the agent
 * isn't actively calling them. Most agent turns hit each server in a short
 * burst, so paying ~150 ms per cold spawn is a good trade for keeping the
 * standing memory cost near zero between bursts.
 *
 * Honors per-server `tools` allow-list and the session-level `excludedTools`
 * filter. Remote (http/sse) MCP servers are ignored — BYOK only deals with
 * local stdio servers (matches what the agent actually configures).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '@/AI/AIAgent/shared/types/mcpConfig';
import { matchesSubAgentWhitelist } from '@/AI/AIAgent/shared/subAgents/whitelist';
import { getActiveSearchRepoKeys } from '@/AI/AIAgent/shared/memory/groups';
import { loadSettings } from '@/utils/common';

export interface ToolClient {
    callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{
        content?: Array<{ type: string; text?: string }>;
        [k: string]: unknown;
    }>;
}

export interface RegisteredTool {
    server: string;
    originalName: string;
    namespacedName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    client: ToolClient;
}

export interface McpClientPool {
    tools: Map<string, RegisteredTool>;
    openaiTools: Array<{
        type: 'function';
        function: { name: string; description: string; parameters: Record<string, unknown> };
    }>;
    disconnect: () => Promise<void>;
}

interface BuildPoolOptions {
    servers: Record<string, MCPServerConfig>;
    excludedTools?: string[];
    /**
     * Positive filter applied AFTER `excludedTools`. When set, only tools
     * whose namespaced name (`<server>__<tool>`) matches an entry — using
     * the same trailing-segment matcher as the sub-agent whitelist — are
     * registered. Used by sub-agent sessions to keep the model's tool
     * inventory tightly scoped.
     */
    allowedTools?: string[];
    workingDirectory: string;
}

interface LazyClientSpec {
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    idleTimeoutMs: number;
}

const DEFAULT_MCP_IDLE_TIMEOUT_MS = 5_000;
const MAX_MCP_IDLE_TIMEOUT_MS = 3_600_000;

async function loadMcpClientIdleTimeoutMs(): Promise<number> {
    try {
        const settings = await loadSettings();
        const raw = settings.ai?.agent?.mcpClientIdleTimeoutMs;
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            const i = Math.round(raw);
            if (i < 0) return 0;
            if (i > MAX_MCP_IDLE_TIMEOUT_MS) return MAX_MCP_IDLE_TIMEOUT_MS;

            return i;
        }
    } catch {
        // Settings unavailable — fall back to default.
    }

    return DEFAULT_MCP_IDLE_TIMEOUT_MS;
}

function namespacedToolName(server: string, tool: string): string {
    const safeServer = server.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_');

    return `${safeServer}__${safeTool}`;
}

/**
 * Lazy stdio MCP client. Spawns the server on first `callTool` (or via the
 * helper `withConnection` used at build time for `tools/list`), reuses the
 * connection across overlapping calls, and shuts down after `idleTimeoutMs`
 * of inactivity. Refcounts in-flight calls so an idle timer never fires
 * while work is pending.
 */
class LazyClient implements ToolClient {
    private readonly spec: LazyClientSpec;
    private client: Client | undefined;
    private connecting: Promise<Client> | undefined;
    private inflight = 0;
    private idleTimer: NodeJS.Timeout | undefined;
    private closed = false;

    public constructor(spec: LazyClientSpec) {
        this.spec = spec;
    }

    public async callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{
        content?: Array<{ type: string; text?: string }>;
        [k: string]: unknown;
    }> {
        const client = await this.acquire();
        try {
            return (await client.callTool(req)) as {
                content?: Array<{ type: string; text?: string }>;
                [k: string]: unknown;
            };
        } finally {
            this.release();
        }
    }

    /**
     * Acquire a connected `Client`. Used by `buildMcpClientPool` to perform
     * the initial `tools/list` enumeration; the caller MUST `release()` once
     * done so the idle timer can re-arm.
     */
    public async withConnection<T>(fn: (client: Client) => Promise<T>): Promise<T> {
        const client = await this.acquire();
        try {
            return await fn(client);
        } finally {
            this.release();
        }
    }

    public async close(): Promise<void> {
        this.closed = true;
        this.cancelIdleTimer();
        // Wait briefly for in-flight calls to drain; in practice the pool is
        // disconnected only at session teardown, after the orchestrator stops
        // issuing tool calls.
        const deadline = Date.now() + 5_000;
        while (this.inflight > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        await this.shutdownTransport();
    }

    private async acquire(): Promise<Client> {
        if (this.closed) {
            throw new Error(`MCP client for '${this.spec.serverName}' is closed`);
        }
        this.cancelIdleTimer();
        this.inflight++;

        if (this.client) {
            return this.client;
        }

        if (!this.connecting) {
            this.connecting = this.spawn();
        }
        try {
            const client = await this.connecting;
            this.client = client;

            return client;
        } catch (err) {
            this.inflight--;
            this.connecting = undefined;
            throw err;
        }
    }

    private release(): void {
        if (this.inflight > 0) this.inflight--;
        if (this.inflight === 0 && !this.closed) {
            this.scheduleIdleShutdown();
        }
    }

    private scheduleIdleShutdown(): void {
        const ms = this.spec.idleTimeoutMs;
        if (ms <= 0) {
            // 0 ⇒ shut down immediately when idle (cold-spawn every call).
            void this.shutdownTransport();

            return;
        }
        this.cancelIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (this.inflight === 0 && !this.closed) {
                void this.shutdownTransport();
            }
        }, ms);
        this.idleTimer.unref();
    }

    private cancelIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private async spawn(): Promise<Client> {
        const transport = new StdioClientTransport({
            command: this.spec.command,
            args: this.spec.args,
            env: this.spec.env,
            ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
        });
        const client = new Client(
            { name: 'kra-byok-agent', version: '1.0.0' },
            { capabilities: {} }
        );
        try {
            await client.connect(transport);
        } catch (err) {
            this.connecting = undefined;
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to connect MCP server '${this.spec.serverName}': ${message}`);
        }
        this.connecting = undefined;
        // Keep a reference so V8 doesn't GC the transport while client owns it.
        void transport;

        return client;
    }

    private async shutdownTransport(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        this.connecting = undefined;
        if (!client) return;
        try {
            await client.close();
        } catch {
            // Best-effort; the child may already be gone.
        }
    }
}

export async function buildMcpClientPool(options: BuildPoolOptions): Promise<McpClientPool> {
    const tools = new Map<string, RegisteredTool>();
    const lazyClients: LazyClient[] = [];
    const excluded = new Set(options.excludedTools ?? []);
    const allowedSet = options.allowedTools ? new Set(options.allowedTools) : null;

    // Resolve the active multi-repo search group once per pool build so each
    // spawned MCP server inherits the same set. Empty list ⇒ single-repo mode
    // (memoryMcpServer falls back to WORKING_DIR's repo on its own).
    const activeRepoKeys = await getActiveSearchRepoKeys();
    const searchRepoKeysEnv = activeRepoKeys.length > 0 ? activeRepoKeys.join(',') : '';
    const idleTimeoutMs = await loadMcpClientIdleTimeoutMs();

    for (const [serverName, config] of Object.entries(options.servers)) {
        if (config.type !== 'local' && config.type !== 'stdio') {
            continue;
        }

        const env: Record<string, string> = {
            ...Object.fromEntries(
                Object.entries(process.env).filter(([, value]) => value !== undefined) as [string, string][]
            ),
            ...(config.env ?? {}),
            WORKING_DIR: options.workingDirectory,
            ...(searchRepoKeysEnv ? { KRA_SEARCH_REPO_KEYS: searchRepoKeysEnv } : {}),
        };

        const lazyClient = new LazyClient({
            serverName,
            command: config.command,
            args: config.args ?? [],
            env,
            ...(config.cwd ? { cwd: config.cwd } : {}),
            idleTimeoutMs,
        });

        const allowList = config.tools ? new Set(config.tools) : null;
        let listed: { tools: Array<{ name: string; description?: string | undefined; inputSchema?: unknown }> };
        try {
            listed = await lazyClient.withConnection(async (client) => client.listTools());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await lazyClient.close().catch(() => undefined);
            throw new Error(`Failed to enumerate MCP server '${serverName}': ${message}`);
        }

        lazyClients.push(lazyClient);

        for (const tool of listed.tools) {
            if (allowList && !allowList.has(tool.name)) {
                continue;
            }

            const namespaced = namespacedToolName(serverName, tool.name);

            if (allowedSet) {
                // Sub-agent path: positive whitelist wins. `excluded` is
                // intended for SDK built-in names (e.g. 'bash', 'search')
                // and we must not let those bare names accidentally strip
                // a same-named MCP tool the whitelist explicitly allows.
                if (!matchesSubAgentWhitelist(namespaced, allowedSet)) {
                    continue;
                }
            } else if (excluded.has(tool.name)) {
                // Orchestrator path: honour caller-supplied excludes.
                continue;
            }

            tools.set(namespaced, {
                server: serverName,
                originalName: tool.name,
                namespacedName: namespaced,
                description: tool.description ?? '',
                inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
                    type: 'object',
                    properties: {},
                },
                client: lazyClient,
            });
        }
    }

    const openaiTools = Array.from(tools.values()).map((t) => ({
        type: 'function' as const,
        function: {
            name: t.namespacedName,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));

    return {
        tools,
        openaiTools,
        disconnect: async (): Promise<void> => {
            await Promise.allSettled(lazyClients.map(async (c) => c.close()));
        },
    };
}
