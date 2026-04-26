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
import type { MemorySettings } from './types';

export interface WatcherHandle {
    close: () => Promise<void>;
}

const DEBOUNCE_MS = 500;

export async function startWatcher(): Promise<WatcherHandle | null> {
    const settings = await loadMemorySettings();

    if (!settings.enabled || !settings.indexCodeOnSave) return null;

    const root = workspaceRoot();
    const ignored = (filePath: string): boolean => {
        const rel = path.relative(root, filePath);

        if (rel === '' || rel.startsWith('..')) return false;

        // Ignore directories that shouldn't be traversed even partially.
        if (rel.split(path.sep).some((p) => p === 'node_modules' || p === '.git' || p === '.kra-memory' || p === 'dest' || p === 'dist')) {
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

    const pending = new Map<string, NodeJS.Timeout>();

    const schedule = (kind: 'index' | 'remove', rel: string, currentSettings: MemorySettings): void => {
        const existing = pending.get(rel);

        if (existing) clearTimeout(existing);

        pending.set(rel, setTimeout(() => {
            pending.delete(rel);
            void run(kind, rel, currentSettings);
        }, DEBOUNCE_MS));
    };

    const handle = (event: 'add' | 'change' | 'unlink', filePath: string): void => {
        const rel = path.relative(root, filePath);

        if (rel === '' || rel.startsWith('..')) return;

        if (event === 'unlink') {
            schedule('remove', rel, settings);

            return;
        }

        if (!isIndexable(rel, settings)) return;
        schedule('index', rel, settings);
    };

    watcher.on('add', (p) => handle('add', p));
    watcher.on('change', (p) => handle('change', p));
    watcher.on('unlink', (p) => handle('unlink', p));

    return {
        close: async () => {
            for (const t of pending.values()) clearTimeout(t);
            pending.clear();
            await watcher.close();
        },
    };
}

async function run(kind: 'index' | 'remove', rel: string, settings: MemorySettings): Promise<void> {
    try {
        // Only the repos the user has explicitly opted into (i.e. a registry
        // entry exists) participate in incremental indexing. Without this
        // guard, any file save in an opted-out repo would silently recreate
        // the code_chunks table.
        const root = workspaceRoot();
        const identity = await getRepoIdentity(root);
        const existing = await getRegistryEntry(identity.id);
        if (!existing) return;

        if (kind === 'remove') {
            await removeFile(rel);
        } else {
            await indexFile(rel, { settings });
        }
        await touchRegistryLastIndexed();
    } catch (err) {
        process.stderr.write(`[kra-memory] watcher ${kind} failed for ${rel}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}

async function touchRegistryLastIndexed(): Promise<void> {
    try {
        const root = workspaceRoot();
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
