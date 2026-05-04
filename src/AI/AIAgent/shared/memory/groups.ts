/**
 * Search-group configuration for the kra-memory layer.
 *
 * A "group" is a list of repoKeys whose `code_chunks` indexes should be
 * searched together by a single agent session. Persisted at
 * `~/.kra/.kra-memory/groups.json`:
 *
 *   {
 *     "version": 1,
 *     "active": ["a861e0135e96df54", "d37c083c9d0ddfd2"],
 *     "saved":  { "tools": ["a861…", "d37c…"] }
 *   }
 *
 * `active` is what new agent sessions pick up by default. `saved` is for
 * named groups (UI v2). When `active` is empty/missing, callers fall back
 * to single-repo behavior (the current cwd's repo only).
 *
 * The MCP server reads `KRA_SEARCH_REPO_KEYS` (comma-separated) which the
 * spawning provider derives from this file. The env var wins over the
 * file when both are set, so a sub-process can be locked to a fixed group.
 */

import * as fs from 'fs/promises';
import path from 'path';
import { kraMemoryRoot } from '@/filePaths';

export interface SearchGroups {
    version: 1;
    active: string[];
    saved: Record<string, string[]>;
}

const EMPTY_GROUPS: SearchGroups = { version: 1, active: [], saved: {} };

function groupsPath(): string {
    return path.join(kraMemoryRoot, 'groups.json');
}

export async function loadGroups(): Promise<SearchGroups> {
    try {
        const raw = await fs.readFile(groupsPath(), 'utf8');
        const parsed = JSON.parse(raw) as { version?: unknown; active?: unknown; saved?: unknown } | null;

        if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) {
            return { ...EMPTY_GROUPS, saved: {} };
        }

        const active = Array.isArray(parsed.active) ? (parsed.active as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
        const saved: Record<string, string[]> = {};
        if (parsed.saved !== null && typeof parsed.saved === 'object') {
            for (const [name, list] of Object.entries(parsed.saved as Record<string, unknown>)) {
                if (Array.isArray(list)) {
                    saved[name] = (list as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0);
                }
            }
        }

        return { version: 1, active, saved };
    } catch {
        return { ...EMPTY_GROUPS, saved: {} };
    }
}

export async function saveGroups(groups: SearchGroups): Promise<void> {
    await fs.mkdir(kraMemoryRoot, { recursive: true });
    await fs.writeFile(groupsPath(), `${JSON.stringify(groups, null, 2)}\n`);
}

export async function setActiveGroup(repoKeys: string[]): Promise<void> {
    const groups = await loadGroups();
    const dedup = Array.from(new Set(repoKeys.filter((k) => typeof k === 'string' && k.length > 0)));
    groups.active = dedup;
    await saveGroups(groups);
}

/**
 * Resolve the active list of repoKeys for the current process.
 * `KRA_SEARCH_REPO_KEYS` env (comma-separated) wins over groups.json.
 * Returns [] when neither is set — callers should fall back to single-repo.
 */
export async function getActiveSearchRepoKeys(): Promise<string[]> {
    const env = process.env['KRA_SEARCH_REPO_KEYS'];
    if (typeof env === 'string' && env.trim().length > 0) {
        return env.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }

    const groups = await loadGroups();

    return groups.active;
}
