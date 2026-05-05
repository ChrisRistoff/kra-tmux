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
    ExecutorSettings,
    InvestigatorSettings,
    SubAgentSettings,
} from './types';

const DEFAULT_EXECUTOR_TOOLS = [
    'read_lines',
    'get_outline',
    'anchor_edit',
    'create_file',
    'search',
    'lsp_query',
    'bash',
];

const DEFAULT_INVESTIGATOR_TOOLS = [
    'semantic_search',
    'search',
    'get_outline',
    'read_lines',
    'lsp_query',
    'docs_search',
    'recall',
];

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
    enabled: false,
    maxEvidenceItems: 8,
    maxExcerptLines: 20,
    validateExcerpts: true,
    toolWhitelist: DEFAULT_INVESTIGATOR_TOOLS,
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
    enabled?: boolean;
    maxEvidenceItems?: number;
    maxExcerptLines?: number;
    validateExcerpts?: boolean;
    toolWhitelist?: string[];
}

interface RawAgent {
    executor?: RawExecutor;
    investigator?: RawInvestigator;
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

    return {
        executor: mergeExecutor(raw.executor),
        investigator: mergeInvestigator(raw.investigator),
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

export function mergeInvestigator(raw: RawInvestigator | undefined): InvestigatorSettings {
    if (!raw || typeof raw !== 'object') return { ...INVESTIGATOR_DEFAULTS };

    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : INVESTIGATOR_DEFAULTS.enabled,
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
