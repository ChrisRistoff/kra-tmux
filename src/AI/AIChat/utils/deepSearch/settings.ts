/**
 * Settings for the chat-side `deep_search` tool.
 *
 * Reads `[ai.chat.deepSearch]` from `~/.kra/settings.toml` and applies the
 * same shape/clamp logic as the agent's `[ai.agent.investigatorWeb]` block
 * (see `subAgents/settings.ts`). The two are independent so the chat and
 * agent can be tuned separately, but they share the underlying type and
 * validation helpers to avoid drift.
 *
 * Disabled by default — chat callers MUST opt in.
 */

import * as toml from 'smol-toml';
import { promises as fs } from 'fs';

import { settingsFilePath } from '@/filePaths';
import {
    mergeWebInvestigator,
} from '@/AI/AIAgent/shared/subAgents/settings';
import type { WebInvestigatorSettings } from '@/AI/AIAgent/shared/subAgents/types';

export interface DeepSearchSettings extends WebInvestigatorSettings {
    enabled: boolean;
}

interface RawDeepSearch {
    enabled?: boolean;
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

export async function loadDeepSearchSettings(): Promise<DeepSearchSettings> {
    let raw: RawDeepSearch | undefined;

    try {
        const content = await fs.readFile(settingsFilePath, 'utf8');
        const parsed = toml.parse(content) as { ai?: { chat?: { deepSearch?: RawDeepSearch } } };
        raw = parsed.ai?.chat?.deepSearch;
    } catch {
        // settings.toml missing — fall through to defaults.
    }

    const merged = mergeWebInvestigator(raw);
    const enabled = !!(raw && typeof raw === 'object' && raw.enabled === true);

    return { ...merged, enabled };
}
