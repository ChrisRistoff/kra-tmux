/**
 * Central registry of code-indexed repositories.
 *
 * Lives at `~/.kra-memory/registry.json`. Each entry is keyed by a stable
 * repo identity (git origin URL when available, falling back to the absolute
 * top-level path) and records the metadata the agent needs to decide whether
 * to re-index, what to catch up, and how to label the repo in the UI.
 *
 * The actual code-chunks LanceDB still lives at `${repoRoot}/.kra-memory/`
 * and is opened per-cwd by `db.ts` — this registry is pure metadata, not the
 * data store.
 */

import os from 'os';
import path from 'path';
import * as fs from 'fs/promises';
import { atomicWriteFile } from '@/AI/AIAgent/shared/utils/fileSafety';
import { execCommand } from '@/utils/bashHelper';

export interface RegistryEntry {
    /** Display alias (basename of repo by default; user-editable later). */
    alias: string;
    /** Absolute top-level path of the repo on this machine. */
    rootPath: string;
    /** Last commit SHA the index was synced against. Empty for non-git repos. */
    lastIndexedCommit: string;
    /** Epoch-ms of the most recent index/catch-up. */
    lastIndexedAt: number;
    /** Cached chunk count for status displays. Refreshed after each reindex. */
    chunksCount: number;
}

export interface Registry {
    version: 1;
    repos: Record<string, RegistryEntry>;
}

const EMPTY_REGISTRY: Registry = { version: 1, repos: {} };

function registryRoot(): string {
    return path.join(os.homedir(), '.kra-memory');
}

function registryPath(): string {
    return path.join(registryRoot(), 'registry.json');
}

/**
 * Resolve a stable identifier for the repo rooted at `cwd`. Prefers the git
 * remote origin URL because it survives renames and re-clones; falls back to
 * the absolute top-level path for non-git workspaces.
 */
export async function getRepoIdentity(cwd: string): Promise<{ id: string; rootPath: string; alias: string }> {
    const top = await tryExec(`git -C '${cwd.replace(/'/g, `'\\''`)}' rev-parse --show-toplevel`);
    const rootPath = top ?? path.resolve(cwd);

    const origin = await tryExec(`git -C '${rootPath.replace(/'/g, `'\\''`)}' config --get remote.origin.url`);
    const id = origin && origin.length > 0 ? origin : rootPath;
    const alias = path.basename(rootPath);

    return { id, rootPath, alias };
}

async function tryExec(cmd: string): Promise<string | null> {
    try {
        const result = await execCommand(cmd);
        const out = result.stdout.trim();

        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

export async function loadRegistry(): Promise<Registry> {
    const file = registryPath();

    try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw) as Partial<Registry>;

        if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.repos) {
            return { ...EMPTY_REGISTRY };
        }

        return { version: 1, repos: parsed.repos };
    } catch {
        return { ...EMPTY_REGISTRY };
    }
}

export async function saveRegistry(reg: Registry): Promise<void> {
    await fs.mkdir(registryRoot(), { recursive: true });
    await atomicWriteFile(registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

export async function getRegistryEntry(id: string): Promise<RegistryEntry | undefined> {
    const reg = await loadRegistry();

    return reg.repos[id];
}

/**
 * Merge `patch` into the entry for `id`, creating the entry if it does not
 * yet exist. `alias` and `rootPath` must be supplied on first creation.
 */
export async function upsertRegistryEntry(
    id: string,
    patch: Partial<RegistryEntry> & { alias?: string; rootPath?: string },
): Promise<RegistryEntry> {
    const reg = await loadRegistry();
    const existing = reg.repos[id];

    const next: RegistryEntry = {
        alias: patch.alias ?? existing?.alias ?? id,
        rootPath: patch.rootPath ?? existing?.rootPath ?? '',
        lastIndexedCommit: patch.lastIndexedCommit ?? existing?.lastIndexedCommit ?? '',
        lastIndexedAt: patch.lastIndexedAt ?? existing?.lastIndexedAt ?? 0,
        chunksCount: patch.chunksCount ?? existing?.chunksCount ?? 0,
    };

    reg.repos[id] = next;
    await saveRegistry(reg);

    return next;
}

export async function removeRegistryEntry(id: string): Promise<boolean> {
    const reg = await loadRegistry();

    if (!(id in reg.repos)) return false;
    delete reg.repos[id];
    await saveRegistry(reg);

    return true;
}
