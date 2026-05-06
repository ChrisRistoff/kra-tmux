/**
 * Chokidar-backed file watcher for incremental code-chunk reindexing.
 *
 * Events are debounced per-path so a flurry of writes (e.g. formatter on
 * save) collapses into one reindex. Only paths matching the include filter
 * are reindexed; deletes remove the file's chunks entirely.
 */

import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { indexFile, isIndexable, removeFile, workspaceRoot } from './indexer';
import { loadMemorySettings } from './settings';
import { getRepoIdentity, upsertRegistryEntry, getRegistryEntry } from './registry';
import { computeRepoKey } from './repoKey';
import type { MemorySettings } from './types';

export interface WatcherHandle {
    close: () => Promise<void>;
}

const DEBOUNCE_MS = 500;

export async function startWatcher(roots?: string[]): Promise<WatcherHandle | null> {
    const settings = await loadMemorySettings();

    if (!settings.enabled || !settings.indexCodeOnSave) return null;

    const watchRoots = (roots && roots.length > 0)
        ? Array.from(new Set(roots.map((r) => path.resolve(r))))
        : [workspaceRoot()];

    const subWatchers: FSWatcher[] = [];
    const pending = new Map<string, NodeJS.Timeout>();

    const scheduleFor = (root: string, kind: 'index' | 'remove', rel: string, currentSettings: MemorySettings): void => {
        const key = `${root}\u0000${rel}`;
        const existing = pending.get(key);

        if (existing) clearTimeout(existing);

        pending.set(key, setTimeout(() => {
            pending.delete(key);
            void run(root, kind, rel, currentSettings);
        }, DEBOUNCE_MS));
    };

    for (const root of watchRoots) {
        const ignored = (filePath: string): boolean => {
            const rel = path.relative(root, filePath);

            if (rel === '' || rel.startsWith('..')) return false;

            if (rel.split(path.sep).some((p) => p === 'node_modules' || p === '.git' || p === 'dest' || p === 'dist')) {
                return true;
            }

            return false;
        };

        const watcher = chokidar.watch(root, {
            ignored,
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });

        const handle = (event: 'add' | 'change' | 'unlink', filePath: string): void => {
            const rel = path.relative(root, filePath);

            if (rel === '' || rel.startsWith('..')) return;

            if (event === 'unlink') {
                scheduleFor(root, 'remove', rel, settings);

                return;
            }

            if (!isIndexable(rel, settings)) return;
            scheduleFor(root, 'index', rel, settings);
        };

        watcher.on('add', (p) => handle('add', p));
        watcher.on('change', (p) => handle('change', p));
        watcher.on('unlink', (p) => handle('unlink', p));
        subWatchers.push(watcher);
    }

    return {
        close: async () => {
            for (const t of pending.values()) clearTimeout(t);
            pending.clear();
            await Promise.all(subWatchers.map(async (w) => w.close()));
        },
    };
}

/**
 * Reindex `rel` inside `root`. We resolve the repo identity to a stable
 * `repoKey` and pass it explicitly to indexFile/removeFile so each watcher
 * event targets the correct per-repo LanceDB without mutating WORKING_DIR.
 * That makes concurrent saves across multiple repos safe.
 */
async function run(root: string, kind: 'index' | 'remove', rel: string, settings: MemorySettings): Promise<void> {
    try {
        // Only the repos the user has explicitly opted into (i.e. a registry
        // entry exists) participate in incremental indexing. Without this
        // guard, any file save in an opted-out repo would silently recreate
        // the code_chunks table.
        const identity = await getRepoIdentity(root);
        const existing = await getRegistryEntry(identity.id);
        if (!existing) return;

        const repoKey = computeRepoKey(identity.id);

        if (kind === 'remove') {
            await removeFile(rel, repoKey);
        } else {
            await indexFile(rel, { settings, root, repoKey });
        }
        await touchRegistryLastIndexed(root);
    } catch (err) {
        process.stderr.write(`[kra-memory] watcher ${kind} failed for ${root}/${rel}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}

async function touchRegistryLastIndexed(root: string): Promise<void> {
    try {
        const identity = await getRepoIdentity(root);
        const existing = await getRegistryEntry(identity.id);
        if (!existing) return; // Only bump for repos the user explicitly opted into.
        await upsertRegistryEntry(identity.id, { lastIndexedAt: Date.now() });
    } catch {
        // Registry update is best-effort; never block the watcher on it.
    }
}

// Eslint can complain about unused FSWatcher import in some configs; the type
// is referenced via chokidar's return value typing.
export type { FSWatcher };
