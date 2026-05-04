/**
 * Shared types for the kra-memory layer.
 *
 * The memory layer is provider-neutral and lives entirely under
 * `src/AI/AIAgent/shared/memory/`. It is exposed to agents through the
 * `kra-memory` MCP server (`src/AI/AIAgent/shared/utils/memoryMcpServer.ts`).
 */

export const FINDING_KINDS = [
    'note',
    'bug-fix',
    'gotcha',
    'decision',
    'investigation',
] as const;

export const REVISIT_KIND = 'revisit';

export const MEMORY_KINDS = [
    ...FINDING_KINDS,
    REVISIT_KIND,
] as const;
export const MEMORY_LOOKUP_KINDS = ['findings', ...MEMORY_KINDS] as const;

export type FindingKind = typeof FINDING_KINDS[number];
export type RevisitKind = typeof REVISIT_KIND;
export type MemoryKind = typeof MEMORY_KINDS[number];
export type MemoryLookupKind = typeof MEMORY_LOOKUP_KINDS[number];

export function isRevisitKind(kind: string): kind is RevisitKind {
    return kind === REVISIT_KIND;
}

export function isFindingKind(kind: string): kind is FindingKind {
    return (FINDING_KINDS as readonly string[]).includes(kind);
}

export function isMemoryLookupKind(kind: string): kind is MemoryLookupKind {
    return kind === 'findings' || (MEMORY_KINDS as readonly string[]).includes(kind);
}

export const MEMORY_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

export const MEMORY_SOURCES = ['user', 'agent-auto'] as const;
export type MemorySource = typeof MEMORY_SOURCES[number];

/**
 * Row shape stored in the LanceDB `memory` table.
 *
 * `tags` and `paths` are JSON-encoded string arrays. We store them as plain
 * strings rather than Arrow lists so post-fetch filtering stays trivial; the
 * collection is small (hundreds-to-thousands of entries) so a Lance vector
 * scan + JS filter is fast enough for Phase 1.
 */
export interface MemoryRow {
    id: string;
    kind: MemoryKind;
    title: string;
    body: string;
    tags: string;
    paths: string;
    branch: string;
    status: MemoryStatus;
    resolution: string;
    createdAt: number;
    updatedAt: number;
    source: MemorySource;
    vector: number[];
}

/**
 * Decoded view of a memory row, returned to MCP callers.
 */
export interface MemoryEntry {
    id: string;
    kind: MemoryKind;
    title: string;
    body: string;
    tags: string[];
    paths: string[];
    branch: string | null;
    status: MemoryStatus;
    resolution: string | null;
    createdAt: number;
    updatedAt: number;
    source: MemorySource;
}

export interface MemoryEntryWithScore extends MemoryEntry {
    score: number;
}

export interface RememberInput {
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    paths?: string[];
    branch?: string | null;
    source?: MemorySource;
}

export interface RememberInput {
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    paths?: string[];
    branch?: string | null;
    source?: MemorySource;
}

export interface RecallInput {
    query?: string;
    k?: number;
    kind: MemoryLookupKind;
    selectedIds?: string[];
    tagsAny?: string[];
    status?: MemoryStatus;
}

export interface UpdateMemoryInput {
    id: string;
    status: 'open' | 'resolved' | 'dismissed';
    resolution?: string;
}

export interface EditMemoryInput {
    id: string;
    kind?: MemoryKind;
    title?: string;
    body?: string;
    tags?: string[];
    paths?: string[];
    branch?: string | null;
}

/**
 * Row stored in the LanceDB `code_chunks` table.
 *
 * Phase 2: code semantic search. One row per chunk of a source file. The
 * indexer chunks files into ~80-line windows with 5-line overlap and embeds
 * each chunk independently. `contentHash` lets the incremental indexer skip
 * unchanged chunks across reindex passes.
 */
export interface CodeChunkRow {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    symbol: string;
    language: string;
    content: string;
    contentHash: string;
    indexedAt: number;
    vector: number[];
}

export interface SemanticOutlineEntry {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    matched: boolean;
}

export interface CodeFileHitData {
    path: string;
    language: string;
    lineCount: number;
    startLines: number[];
    endLines: number[];
    outline?: SemanticOutlineEntry[];
    outlineAccurate?: boolean;
    // Set only when fan-out across multiple repos is active. `repo` is the
    // registry alias and `rootPath` the absolute repo top-level so the
    // agent can resolve `path` against the right working tree.
    repo?: string;
    rootPath?: string;
}

export interface SemanticSearchInput {
    query: string;
    k?: number;
    scope?: 'code' | 'memory' | 'both';
    pathGlob?: string;
    memoryKind?: MemoryLookupKind;
    selectedIds?: string[];
}

export interface SemanticSearchHit {
    type: 'code' | 'memory';
    score: number;
    code?: CodeFileHitData;
    memory?: MemoryEntry;
}

export interface IndexProgress {
    phase: 'scanning' | 'chunking' | 'embedding' | 'writing' | 'done';
    filesTotal: number;
    filesDone: number;
    chunksTotal: number;
    chunksWritten: number;
    currentPath?: string;
}

/**
 * User-tunable settings for the kra-memory layer, parsed from the
 * `[ai.agent.memory]` block in `settings.toml`. All fields are optional in
 * TOML; `loadMemorySettings()` fills in defaults.
 */
export interface MemorySettings {
    enabled: boolean;
    indexCodeOnStart: boolean;
    indexCodeOnSave: boolean;
    autoSurfaceOnStart: boolean;
    gitignoreMemory: boolean;
    includeExtensions: string[];
    excludeGlobs: string[];
    chunkLines: number;
    chunkOverlap: number;
}


export function decodeRow(row: MemoryRow): MemoryEntry {
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        tags: parseList(row.tags),
        paths: parseList(row.paths),
        branch: row.branch === '' ? null : row.branch,
        status: row.status,
        resolution: row.resolution === '' ? null : row.resolution,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        source: row.source,
    };
}

function parseList(serialized: string): string[] {
    if (!serialized) {
        return [];
    }

    try {
        const parsed = JSON.parse(serialized) as unknown;

        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
