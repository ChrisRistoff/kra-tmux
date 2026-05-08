/**
 * Settings loader for the optional executor + investigator sub-agents.
 *
 * Reads `[ai.agent.executor]` and `[ai.agent.investigator]` from `settings.toml`
 * and fills in defaults. Both are disabled by default; when enabled, the BYOK
 * start flow prompts for a provider + model for each.
 *
 * Mirrors the shape of `loadMemorySettings` so the rest of the agent code can
 * rely on a fully-populated, normalised object.
 */

import fs from 'fs/promises';
import * as toml from 'smol-toml';
import { settingsFilePath } from '@/filePaths';
import type {
    AgentTruncationSettings,
    ExecutorSettings,
    InvestigatorSettings,
    SubAgentSettings,
    WebInvestigatorSettings,
} from './types';

const DEFAULT_EXECUTOR_TOOLS = [
    // reading
    'read_lines',
    'get_outline',
    'read_function',
    'search',
    'lsp_query',
    'semantic_search',
    'recall',
    'docs_search',
    // writing
    'anchor_edit',
    'create_file',
    'bash',
];

const DEFAULT_INVESTIGATOR_TOOLS = [
    // all reading operations + bash; no write tools
    'semantic_search',
    'search',
    'get_outline',
    'read_lines',
    'read_function',
    'lsp_query',
    'docs_search',
    'recall',
    'bash',
];

const DEFAULT_WEB_INVESTIGATOR_TOOLS = [
    'web_search',
    'web_scrape_and_index',
    'research_query',
];

const DEFAULT_NEVER_TRUNCATE = ['semantic_search', 'docs_search', 'recall', 'get_outline'];

const ORCHESTRATOR_TRUNCATION_DEFAULTS: AgentTruncationSettings = {
    defaultHead: 4000,
    defaultTail: 4000,
    bashHead: 2000,
    bashTail: 6000,
    neverTruncate: DEFAULT_NEVER_TRUNCATE,
};

const SUB_AGENT_TRUNCATION_DEFAULTS: AgentTruncationSettings = {
    defaultHead: 8000,
    defaultTail: 8000,
    bashHead: 4000,
    bashTail: 12000,
    neverTruncate: DEFAULT_NEVER_TRUNCATE,
};

const EXECUTOR_DEFAULTS: ExecutorSettings = {
    enabled: false,
    useInvestigatorRuntime: true,
    allowInterrupt: true,
    allowReplanEscape: true,
    includeDiffsInLog: true,
    maxToolCalls: 60,
    toolWhitelist: DEFAULT_EXECUTOR_TOOLS,
};

const INVESTIGATOR_DEFAULTS: InvestigatorSettings = {
    code: false,
    web: false,
    maxEvidenceItems: 8,
    maxExcerptLines: 20,
    validateExcerpts: true,
    toolWhitelist: DEFAULT_INVESTIGATOR_TOOLS,
};

const WEB_INVESTIGATOR_DEFAULTS: WebInvestigatorSettings = {
    useInvestigatorRuntime: true,
    maxSearches: 5,
    maxScrapes: 5,
    urlsPerScrape: 30,
    maxToolCalls: 30,
    maxEvidenceItems: 8,
    maxExcerptLines: 20,
    ttlMinutes: 60,
    validateExcerpts: true,
    toolWhitelist: DEFAULT_WEB_INVESTIGATOR_TOOLS,
};

interface RawExecutor {
    enabled?: boolean;
    useInvestigatorRuntime?: boolean;
    allowInterrupt?: boolean;
    allowReplanEscape?: boolean;
    includeDiffsInLog?: boolean;
    maxToolCalls?: number;
    toolWhitelist?: string[];
}

interface RawInvestigator {
    /** Enables the code-investigator (`investigate`). */
    code?: boolean;
    /** Enables the web-investigator (`investigate_web`). */
    web?: boolean;
    maxEvidenceItems?: number;
    maxExcerptLines?: number;
    validateExcerpts?: boolean;
    toolWhitelist?: string[];
}

interface RawWebInvestigator {
    useInvestigatorRuntime?: boolean;
    maxSearches?: number;
    maxScrapes?: number;
    urlsPerScrape?: number;
    maxToolCalls?: number;
    maxEvidenceItems?: number;
    maxExcerptLines?: number;
    ttlMinutes?: number;
    validateExcerpts?: boolean;
    toolWhitelist?: string[];
}

interface RawTruncation {
    defaultHead?: number;
    defaultTail?: number;
    bashHead?: number;
    bashTail?: number;
    neverTruncate?: string[];
}

interface RawAgent {
    executor?: RawExecutor;
    investigator?: RawInvestigator;
    investigatorWeb?: RawWebInvestigator;
    truncation?: RawTruncation;
    subAgentTruncation?: RawTruncation;
}

export async function loadSubAgentSettings(): Promise<SubAgentSettings> {
    let raw: RawAgent = {};

    try {
        const content = await fs.readFile(settingsFilePath, 'utf8');
        const parsed = toml.parse(content) as { ai?: { agent?: RawAgent } };

        if (parsed.ai?.agent && typeof parsed.ai.agent === 'object') {
            raw = parsed.ai.agent;
        }
    } catch {
        // settings.toml not present yet — fall back to defaults.
    }

    const investigator = mergeInvestigator(raw.investigator);
    const investigatorWeb = mergeWebInvestigator(raw.investigatorWeb);

    return {
        executor: mergeExecutor(raw.executor),
        investigator,
        investigatorWeb,
        truncation: mergeTruncation(raw.truncation, ORCHESTRATOR_TRUNCATION_DEFAULTS),
        subAgentTruncation: mergeTruncation(raw.subAgentTruncation, SUB_AGENT_TRUNCATION_DEFAULTS),
    };
}

export function mergeExecutor(raw: RawExecutor | undefined): ExecutorSettings {
    if (!raw || typeof raw !== 'object') return { ...EXECUTOR_DEFAULTS };

    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : EXECUTOR_DEFAULTS.enabled,
        useInvestigatorRuntime: typeof raw.useInvestigatorRuntime === 'boolean'
            ? raw.useInvestigatorRuntime
            : EXECUTOR_DEFAULTS.useInvestigatorRuntime,
        allowInterrupt: typeof raw.allowInterrupt === 'boolean'
            ? raw.allowInterrupt
            : EXECUTOR_DEFAULTS.allowInterrupt,
        allowReplanEscape: typeof raw.allowReplanEscape === 'boolean'
            ? raw.allowReplanEscape
            : EXECUTOR_DEFAULTS.allowReplanEscape,
        includeDiffsInLog: typeof raw.includeDiffsInLog === 'boolean'
            ? raw.includeDiffsInLog
            : EXECUTOR_DEFAULTS.includeDiffsInLog,
        maxToolCalls: clampInt(raw.maxToolCalls, 1, 500, EXECUTOR_DEFAULTS.maxToolCalls),
        toolWhitelist: normaliseStringList(raw.toolWhitelist, EXECUTOR_DEFAULTS.toolWhitelist),
    };
}

export function mergeWebInvestigator(
    raw: RawWebInvestigator | undefined,
): WebInvestigatorSettings {
    if (!raw || typeof raw !== 'object') return { ...WEB_INVESTIGATOR_DEFAULTS };

    return {
        useInvestigatorRuntime: typeof raw.useInvestigatorRuntime === 'boolean'
            ? raw.useInvestigatorRuntime
            : WEB_INVESTIGATOR_DEFAULTS.useInvestigatorRuntime,
        maxSearches: clampInt(raw.maxSearches, 1, 50, WEB_INVESTIGATOR_DEFAULTS.maxSearches),
        maxScrapes: clampInt(raw.maxScrapes, 1, 50, WEB_INVESTIGATOR_DEFAULTS.maxScrapes),
        urlsPerScrape: clampInt(
            raw.urlsPerScrape,
            1,
            200,
            WEB_INVESTIGATOR_DEFAULTS.urlsPerScrape,
        ),
        maxToolCalls: clampInt(raw.maxToolCalls, 1, 500, WEB_INVESTIGATOR_DEFAULTS.maxToolCalls),
        maxEvidenceItems: clampInt(
            raw.maxEvidenceItems,
            1,
            50,
            WEB_INVESTIGATOR_DEFAULTS.maxEvidenceItems,
        ),
        maxExcerptLines: clampInt(
            raw.maxExcerptLines,
            1,
            200,
            WEB_INVESTIGATOR_DEFAULTS.maxExcerptLines,
        ),
        ttlMinutes: clampInt(raw.ttlMinutes, 1, 24 * 60, WEB_INVESTIGATOR_DEFAULTS.ttlMinutes),
        validateExcerpts: typeof raw.validateExcerpts === 'boolean'
            ? raw.validateExcerpts
            : WEB_INVESTIGATOR_DEFAULTS.validateExcerpts,
        toolWhitelist: normaliseStringList(
            raw.toolWhitelist,
            WEB_INVESTIGATOR_DEFAULTS.toolWhitelist,
        ),
    };
}

export function mergeInvestigator(raw: RawInvestigator | undefined): InvestigatorSettings {
    if (!raw || typeof raw !== 'object') return { ...INVESTIGATOR_DEFAULTS };

    return {
        code: typeof raw.code === 'boolean' ? raw.code : INVESTIGATOR_DEFAULTS.code,
        web: typeof raw.web === 'boolean' ? raw.web : INVESTIGATOR_DEFAULTS.web,
        maxEvidenceItems: clampInt(
            raw.maxEvidenceItems,
            1,
            50,
            INVESTIGATOR_DEFAULTS.maxEvidenceItems,
        ),
        maxExcerptLines: clampInt(
            raw.maxExcerptLines,
            1,
            200,
            INVESTIGATOR_DEFAULTS.maxExcerptLines,
        ),
        validateExcerpts: typeof raw.validateExcerpts === 'boolean'
            ? raw.validateExcerpts
            : INVESTIGATOR_DEFAULTS.validateExcerpts,
        toolWhitelist: normaliseStringList(raw.toolWhitelist, INVESTIGATOR_DEFAULTS.toolWhitelist),
    };
}

export function mergeTruncation(
    raw: RawTruncation | undefined,
    defaults: AgentTruncationSettings,
): AgentTruncationSettings {
    if (!raw || typeof raw !== 'object') return { ...defaults, neverTruncate: [...defaults.neverTruncate] };

    return {
        defaultHead: clampInt(raw.defaultHead, 0, 1_000_000, defaults.defaultHead),
        defaultTail: clampInt(raw.defaultTail, 0, 1_000_000, defaults.defaultTail),
        bashHead: clampInt(raw.bashHead, 0, 1_000_000, defaults.bashHead),
        bashTail: clampInt(raw.bashTail, 0, 1_000_000, defaults.bashTail),
        neverTruncate: Array.isArray(raw.neverTruncate)
            ? raw.neverTruncate.filter((x): x is string => typeof x === 'string' && x.length > 0)
            : [...defaults.neverTruncate],
    };
}

function normaliseStringList(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value) || value.length === 0) return [...fallback];
    const filtered = value.filter((x): x is string => typeof x === 'string' && x.length > 0);

    return filtered.length > 0 ? filtered : [...fallback];
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const i = Math.round(value);
    if (i < min) return min;
    if (i > max) return max;

    return i;
}
