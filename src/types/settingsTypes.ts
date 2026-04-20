type WatchOptions = {
    active: boolean,
    watch: {
        windowName: string,
        command: string,
    }
}

type Autosave = {
    active: boolean,
    currentSession: string,
    timeoutMs: number,
}

type BaseMcpServerSettings = {
    active: boolean,
    tools: string[],
    timeoutMs?: number,
}

type LocalMcpServerSettings = BaseMcpServerSettings & {
    type: 'local' | 'stdio',
    command: string,
    args: string[],
    env?: Record<string, string>,
    cwd?: string,
}

type RemoteMcpServerSettings = BaseMcpServerSettings & {
    type: 'http' | 'sse',
    url: string,
    headers?: Record<string, string>,
}

export type McpServerSettings = LocalMcpServerSettings | RemoteMcpServerSettings;

type AgentSettings = {
    defaultModel?: string,
    mcpServers?: Record<string, McpServerSettings>,
}

export type Settings = {
    watchCommands: {
        work: WatchOptions,
        personal: WatchOptions,
    },

    autosave: Autosave,
    ai?: {
        agent?: AgentSettings,
    }
}
