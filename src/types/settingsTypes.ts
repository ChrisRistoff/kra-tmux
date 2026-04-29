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

export type LspServerSettings = {
    active?: boolean,
    extensions: string[],
    cmd: string,
    args?: string[],
    rootMarkers?: string[],
    initOptions?: Record<string, unknown>,
    env?: Record<string, string>,
    spawnTimeoutMs?: number,
    requestTimeoutMs?: number,
}

type AgentSettings = {
    mcpServers?: Record<string, McpServerSettings>,
    memory?: {
        enabled?: boolean,
        indexCodeOnStart?: boolean,
        indexCodeOnSave?: boolean,
        autoSurfaceOnStart?: boolean,
        gitignoreMemory?: boolean,
        includeExtensions?: string[],
        excludeGlobs?: string[],
        chunkLines?: number,
        chunkOverlap?: number,
    },
}

export type DocsSource = {
    alias: string,
    url: string,
    description?: string,
    maxDepth?: number,
    maxPages?: number,
    includePatterns?: string[],
    excludePatterns?: string[],
    mode?: 'auto' | 'http' | 'browser',
    concurrency?: number,
    pageTimeoutMs?: number,
}

export type DocsSettings = {
    enabled?: boolean,
    maxConcurrentSources?: number,
    idleTimeoutMs?: number,
    cacheRawMarkdown?: boolean,
    sources?: DocsSource[],
}

export type Settings = {
    autosave: Autosave,

    ai?: {
        agent?: AgentSettings,
        docs?: DocsSettings,
    },
    lsp?: Record<string, LspServerSettings>,
}
