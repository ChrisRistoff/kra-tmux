/**
 * File-system indexer for the kra-memory code-chunks table.
 *
 * Pipeline:
 *   1. List indexable files (git ls-files when in a repo, fs walk otherwise)
 *   2. For each file: read → chunk → compute content hashes
 *   3. Diff against existing chunk IDs to skip unchanged chunks
 *   4. Embed only new/changed chunks (batched, 32 per call)
 *   5. Upsert: delete old IDs for the file, then add new rows
 *
 * Storage lives at `~/.kra/.kra-memory/repos/<repoKey>/lance/code_chunks.lance/`. Per-file
 * reindex is fast (30–150 ms typical) so the on-save watcher can call
 * `indexFile` without UI hitches.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { embedMany } from './embedder';
import { getCodeChunksTable, memoryDirectoryRoot } from './db';
import { buildChunks } from './chunker';
import { loadMemorySettings } from './settings';
import type { CodeChunkRow, IndexProgress, MemorySettings } from './types';

export type ProgressFn = (progress: IndexProgress) => void;

export interface IndexResult {
    filesScanned: number;
    chunksWritten: number;
    chunksSkipped: number;
    chunksDeleted: number;
    elapsedMs: number;
}

/**
 * Reindex every indexable file in the workspace. Safe to re-run; chunks whose
 * contentHash hasn't changed are skipped.
 */
export async function reindexAll(opts: { onProgress?: ProgressFn; root?: string; repoKey?: string } = {}): Promise<IndexResult> {
    const started = Date.now();
    const settings = await loadMemorySettings();
    const root = opts.root ?? workspaceRoot();
    const rawFiles = await listIndexableFiles(root, settings);

    // Some entries returned by git ls-files (or the fallback walker, racing
    // against deletions) may no longer exist on disk. Stat-filter so we
    // don't bother trying to embed them, and so the live-set we diff the
    // index against below is accurate.
    const liveFiles = await filterExistingFiles(root, rawFiles);
    const liveSet = new Set(liveFiles);

    let chunksWritten = 0;
    let chunksSkipped = 0;
    let chunksDeleted = 0;

    // Orphan cleanup: remove index entries for files that no longer exist
    // on disk OR have been excluded from indexing since they were last
    // embedded. Without this pass, a file that was deleted while the
    // watcher was inactive (or that moved into an excludeGlob) would sit
    // in the vector DB forever, polluting search results.
    const indexedPaths = await listIndexedPaths(opts.repoKey);
    const orphans: string[] = [];
    for (const p of indexedPaths) {
        if (!liveSet.has(p)) orphans.push(p);
    }

    opts.onProgress?.({
        phase: 'scanning',
        filesTotal: liveFiles.length,
        filesDone: 0,
        chunksTotal: 0,
        chunksWritten: 0,
        ...(orphans.length > 0 ? { currentPath: `cleaning up ${orphans.length} stale entries…` } : {}),
    });

    for (const orphan of orphans) {
        try {
            chunksDeleted += await removeFile(orphan, opts.repoKey);
        } catch (err) {
            process.stderr.write(`[kra-memory] orphan removal failed for ${orphan}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }

    const files = liveFiles;

    for (let i = 0; i < files.length; i++) {
        const rel = files[i];

        opts.onProgress?.({
            phase: 'embedding',
            filesTotal: files.length,
            filesDone: i,
            chunksTotal: 0,
            chunksWritten,
            currentPath: rel,
        });

        try {
            const result = await indexFile(rel, opts.repoKey ? { settings, root, repoKey: opts.repoKey } : { settings, root });

            chunksWritten += result.chunksWritten;
            chunksSkipped += result.chunksSkipped;
            chunksDeleted += result.chunksDeleted;
        } catch (err) {
            process.stderr.write(`[kra-memory] index failed for ${rel}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }

    opts.onProgress?.({
        phase: 'done',
        filesTotal: files.length,
        filesDone: files.length,
        chunksTotal: chunksWritten + chunksSkipped,
        chunksWritten,
    });

    return {
        filesScanned: files.length,
        chunksWritten,
        chunksSkipped,
        chunksDeleted,
        elapsedMs: Date.now() - started,
    };
}

interface IndexFileOpts {
    settings?: MemorySettings;
    root?: string;
    repoKey?: string;
}

export interface PerFileResult {
    chunksWritten: number;
    chunksSkipped: number;
    chunksDeleted: number;
}

/**
 * Reindex a single file. `relPath` is relative to the workspace root.
 * If the file no longer exists or is filtered out, all of its existing
 * chunks are removed.
 */
export async function indexFile(relPath: string, opts: IndexFileOpts = {}): Promise<PerFileResult> {
    const settings = opts.settings ?? await loadMemorySettings();
    const root = opts.root ?? workspaceRoot();
    const abs = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
    const rel = path.isAbsolute(relPath) ? path.relative(root, relPath) : relPath;

    let content: string | null = null;

    try {
        const stat = await fs.stat(abs);

        if (!stat.isFile()) return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: await removeFile(rel, opts.repoKey) };

        // Empty files have nothing to embed. Treat them like deleted files
        // so any prior chunks for this path are purged from the DB — we do
        // NOT want stale embeddings hanging around for a file that's now
        // empty. This also covers the watcher path (truncate-to-empty edits).
        if (stat.size === 0) return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: await removeFile(rel, opts.repoKey) };

        if (!isIndexable(rel, settings)) {
            return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: await removeFile(rel, opts.repoKey) };
        }
        content = await fs.readFile(abs, 'utf8');
    } catch {
        return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: await removeFile(rel, opts.repoKey) };
    }

    const built = buildChunks({
        relPath: rel,
        content,
        chunkLines: settings.chunkLines,
        chunkOverlap: settings.chunkOverlap,
        indexedAt: Date.now(),
    });

    if (built.length === 0) {
        return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: await removeFile(rel, opts.repoKey) };
    }

    const existingIds = await existingChunkIdsForPath(rel, opts.repoKey);
    const newIds = new Set(built.map((b) => b.row.id));
    const toDelete = [...existingIds].filter((id) => !newIds.has(id));
    const toInsert = built.filter((b) => !existingIds.has(b.row.id));
    const skipped = built.length - toInsert.length;

    if (toInsert.length === 0 && toDelete.length === 0) {
        return { chunksWritten: 0, chunksSkipped: skipped, chunksDeleted: 0 };
    }

    const vectors = toInsert.length > 0
        ? await embedMany(toInsert.map((b) => b.row.content))
        : [];
    const rows: CodeChunkRow[] = toInsert.map((b, i) => ({ ...b.row, vector: vectors[i] }));

    const seedRow = rows[0] ?? null;
    const { table, justCreated } = await getCodeChunksTable(seedRow, opts.repoKey);

    if (!table) return { chunksWritten: 0, chunksSkipped: skipped, chunksDeleted: 0 };

    if (toDelete.length > 0) {
        const quoted = toDelete.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

        await table.delete(`id IN (${quoted})`);
    }

    let written = 0;

    if (rows.length > 0) {
        if (justCreated) {
            // Seed row was inserted by createTable; add the rest.
            if (rows.length > 1) {
                await table.add(rows.slice(1) as unknown as Record<string, unknown>[]);
            }
        } else {
            await table.add(rows as unknown as Record<string, unknown>[]);
        }
        written = rows.length;
    }

    return { chunksWritten: written, chunksSkipped: skipped, chunksDeleted: toDelete.length };
}

/**
 * Remove every chunk row associated with `relPath`. Returns the number of
 * chunks removed (0 if the table doesn't exist yet).
 */
export async function removeFile(relPath: string, repoKey?: string): Promise<number> {
    const { table } = await getCodeChunksTable(null, repoKey);

    if (!table) return 0;

    const existing = await existingChunkIdsForPath(relPath, repoKey);

    if (existing.size === 0) return 0;

    await table.delete(`path = '${relPath.replace(/'/g, "''")}'`);

    return existing.size;
}

async function filterExistingFiles(root: string, files: string[]): Promise<string[]> {
    const checks = await Promise.all(files.map(async (rel) => {
        try {
            const stat = await fs.stat(path.join(root, rel));
            // Skip non-files and zero-byte files. Empty files produce zero
            // chunks but would still be re-stat'd / re-read on every reindex,
            // showing up in the progress UI as "being indexed" even though
            // there's nothing to embed.
            if (!stat.isFile() || stat.size === 0) return null;
            return rel;
        } catch {
            return null;
        }
    }));
    return checks.filter((rel): rel is string => rel !== null);
}

export async function listIndexedPaths(repoKey?: string): Promise<Set<string>> {
    const { table } = await getCodeChunksTable(null, repoKey);

    if (!table) return new Set();

    try {
        const rows = await table
            .query()
            .select(['path'])
            .toArray();

        return new Set(rows.map((r) => String((r as { path: unknown }).path)));
    } catch {
        return new Set();
    }
}


async function existingChunkIdsForPath(relPath: string, repoKey?: string): Promise<Set<string>> {
    const { table } = await getCodeChunksTable(null, repoKey);

    if (!table) return new Set();

    try {
        const rows = await table
            .query()
            .where(`path = '${relPath.replace(/'/g, "''")}'`)
            .select(['id'])
            .toArray();

        return new Set(rows.map((r) => String((r as { id: unknown }).id)));
    } catch {
        return new Set();
    }
}

export function workspaceRoot(): string {
    return process.env['WORKING_DIR'] ?? process.cwd();
}

export async function memoryDirectory(): Promise<string> {
    return memoryDirectoryRoot();
}

/**
 * List candidate files for indexing. Uses `git ls-files` when available so
 * .gitignore is honoured for free. Falls back to an fs walk otherwise.
 */
export async function listIndexableFiles(root: string, settings: MemorySettings): Promise<string[]> {
    let files: string[] = [];

    try {
        files = await gitLsFiles(root);
    } catch {
        files = await walk(root, root);
    }

    return files.filter((rel) => isIndexable(rel, settings));
}

async function gitLsFiles(root: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        child.stdout.on('data', (b: Buffer) => chunks.push(b));
        child.stderr.on('data', (b: Buffer) => errChunks.push(b));
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`git ls-files exited ${code ?? '?'}: ${Buffer.concat(errChunks).toString()}`));

                return;
            }
            const out = Buffer.concat(chunks).toString('utf8');

            resolve(out.split('\n').filter((line) => line.length > 0));
        });
    });
}

async function walk(root: string, current: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
        const abs = path.join(current, entry.name);
        const rel = path.relative(root, abs);

        if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            out.push(...await walk(root, abs));
        } else if (entry.isFile()) {
            out.push(rel);
        }
    }

    return out;
}

export function isIndexable(relPath: string, settings: MemorySettings): boolean {
    const posix = relPath.split(path.sep).join('/');

    if (!settings.includeExtensions.includes(path.extname(relPath).toLowerCase())) {
        return false;
    }

    for (const glob of settings.excludeGlobs) {
        if (matchGlob(posix, glob)) return false;
    }

    return true;
}

/**
 * Tiny glob matcher: supports `*`, `**`, and exact characters. Good enough
 * for the gitignore-style patterns we ship in defaults; users wanting more
 * power can lean on git ls-files honouring their actual .gitignore.
 */
export function matchGlob(text: string, glob: string): boolean {
    const re = globToRegex(glob);

    return re.test(text);
}

function globToRegex(glob: string): RegExp {
    let pattern = '^';

    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];

        if (ch === '*') {
            if (glob[i + 1] === '*') {
                pattern += '.*';
                i++;
                if (glob[i + 1] === '/') i++;
            } else {
                pattern += '[^/]*';
            }
        } else if (ch === '?') {
            pattern += '[^/]';
        } else if (ch === '.') {
            pattern += '\\.';
        } else if (/[\\^$+(){}|[\]]/.test(ch)) {
            pattern += '\\' + ch;
        } else {
            pattern += ch;
        }
    }
    pattern += '$';

    return new RegExp(pattern);
}

