/**
 * Stable per-repo storage key + central per-repo directory resolver for
 * the kra-memory layer. Storage now lives under
 * `~/.kra/.kra-memory/repos/<repoKey>/` rather than inside each repo.
 *
 * `repoKey` is sha256(identity) truncated to 16 hex chars, where identity
 * is the same value the registry uses (git origin URL when present, else
 * the absolute repo top-level path). Stable across renames when origin
 * exists; deterministic from cwd otherwise.
 */

import crypto from 'crypto';
import * as fs from 'fs/promises';
import path from 'path';
import { kraMemoryRepoRoot } from '@/filePaths';
import { getRepoIdentity } from './registry';

export interface RepoStorageInfo {
    id: string;
    rootPath: string;
    alias: string;
    repoKey: string;
    repoStorageDir: string;
}

export function computeRepoKey(identity: string): string {
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

let cache: RepoStorageInfo | null = null;

export async function resolveRepoStorage(cwd?: string): Promise<RepoStorageInfo> {
    if (cache) return cache;

    const base = cwd ?? process.env['WORKING_DIR'] ?? process.cwd();
    const ident = await getRepoIdentity(base);
    const repoKey = computeRepoKey(ident.id);
    const repoStorageDir = kraMemoryRepoRoot(repoKey);

    const info: RepoStorageInfo = {
        id: ident.id,
        rootPath: ident.rootPath,
        alias: ident.alias,
        repoKey,
        repoStorageDir,
    };
    cache = info;

    // Best-effort identity.json so a human poking at ~/.kra/.kra-memory/repos/
    // can see what each opaque repoKey corresponds to.
    try {
        await fs.mkdir(repoStorageDir, { recursive: true });
        const identityPath = path.join(repoStorageDir, 'identity.json');
        const payload = `${JSON.stringify({ id: info.id, rootPath: info.rootPath, alias: info.alias }, null, 2)}\n`;
        await fs.writeFile(identityPath, payload);
    } catch {
        // best-effort only
    }

    return info;
}

export function repoStorageDirForKey(repoKey: string): string {
    return kraMemoryRepoRoot(repoKey);
}

/** Test-only: clear the per-process cache. */
export function _resetRepoStorageCacheForTest(): void {
    cache = null;
}

/**
 * Clear the per-process repo-storage cache so the next `resolveRepoStorage()`
 * call re-derives the key from the current `WORKING_DIR`. Used when iterating
 * over multiple repos in one process (e.g. multi-repo startup indexing).
 */
export function clearRepoStorageCache(): void {
    cache = null;
}
