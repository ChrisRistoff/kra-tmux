/**
 * `kra ai index` — full reindex of the workspace into the kra-memory
 * code_chunks table. Streams progress to the terminal and updates the
 * central repo registry so future agent launches see the catch-up baseline.
 */

import { computeChangedFiles, type CatchupPlan } from '@/AI/AIAgent/shared/memory/catchup';
import { countCodeChunks } from '@/AI/AIAgent/shared/memory/db';
import {
    indexFile,
    removeFile,
    reindexAll,
    workspaceRoot,
    type IndexResult,
    type ProgressFn,
} from '@/AI/AIAgent/shared/memory/indexer';
import {
    getRepoIdentity,
    getRegistryEntry,
    upsertRegistryEntry,
    type RegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import { execCommand } from '@/utils/bashHelper';

export interface CodeIndexInspection {
    workspaceRoot: string;
    identity: Awaited<ReturnType<typeof getRepoIdentity>>;
    existing: RegistryEntry | undefined;
    needsFreshIndex: boolean;
    plan: CatchupPlan | null;
}

export interface CodeIndexProgress {
    mode: 'full' | 'catchup';
    filesDone: number;
    filesTotal: number;
    message: string;
}

export interface CodeIndexRunResult {
    mode: 'full' | 'catchup';
    filesScanned: number;
    chunksWritten: number;
    chunksSkipped: number;
    chunksDeleted: number;
    totalChunks: number;
    elapsedMs: number;
    alias: string;
    summary: string;
}

async function safeHeadCommit(repoRoot: string): Promise<string> {
    try {
        const r = await execCommand(`git -C '${repoRoot.replace(/'/g, `'\\''`)}' rev-parse HEAD`);

        return r.stdout.trim();
    } catch {
        return '';
    }
}

export async function inspectCurrentCodeIndex(): Promise<CodeIndexInspection> {
    const settings = await loadMemorySettings();
    if (!settings.enabled) {
        throw new Error('kra-memory is disabled in settings.toml ([ai.agent.memory] enabled = false).');
    }

    const root = workspaceRoot();
    const identity = await getRepoIdentity(root);
    const existing = await getRegistryEntry(identity.id);
    const dbChunkCount = await countCodeChunks().catch(() => 0);
    const needsFreshIndex = !existing?.lastIndexedAt || dbChunkCount === 0;

    return {
        workspaceRoot: root,
        identity,
        existing,
        needsFreshIndex,
        plan: needsFreshIndex
            ? null
            : await computeChangedFiles({
                repoRoot: identity.rootPath,
                lastIndexedCommit: existing.lastIndexedCommit,
                lastIndexedAt: existing.lastIndexedAt,
            }),
    };
}

async function persistIndexState(
    inspection: CodeIndexInspection,
    lastIndexedCommit: string,
    fallbackChunksCount: number,
): Promise<number> {
    const totalChunks = await countCodeChunks().catch(() => fallbackChunksCount);
    await upsertRegistryEntry(inspection.identity.id, {
        alias: inspection.existing?.alias ?? inspection.identity.alias,
        rootPath: inspection.identity.rootPath,
        lastIndexedCommit,
        lastIndexedAt: Date.now(),
        chunksCount: totalChunks,
    });

    return totalChunks;
}

async function runFullIndex(onProgress?: (progress: CodeIndexProgress) => void): Promise<IndexResult> {
    let lastPath = '';

    return reindexAll({
        onProgress: ((p) => {
            if (p.phase === 'scanning') {
                onProgress?.({
                    mode: 'full',
                    filesDone: 0,
                    filesTotal: p.filesTotal,
                    message: `scanning workspace, ${p.filesTotal} indexable files found`,
                });
            }

            if (p.phase === 'embedding' && p.currentPath && p.currentPath !== lastPath) {
                lastPath = p.currentPath;
                onProgress?.({
                    mode: 'full',
                    filesDone: p.filesDone + 1,
                    filesTotal: p.filesTotal,
                    message: `✓ ${p.currentPath}`,
                });
            }
        }) satisfies ProgressFn,
    });
}

async function runCatchupIndex(
    plan: CatchupPlan,
    onProgress?: (progress: CodeIndexProgress) => void,
): Promise<Pick<CodeIndexRunResult, 'filesScanned' | 'chunksWritten' | 'chunksSkipped' | 'chunksDeleted' | 'elapsedMs'>> {
    const started = Date.now();
    const total = plan.changes.length;
    const settings = await loadMemorySettings();
    const root = workspaceRoot();
    let chunksWritten = 0;
    let chunksSkipped = 0;
    let chunksDeleted = 0;
    let filesScanned = 0;

    if (total === 0) {
        onProgress?.({ mode: 'catchup', filesDone: 0, filesTotal: 0, message: 'Nothing to catch up. Index is current.' });

        return { filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, chunksDeleted: 0, elapsedMs: Date.now() - started };
    }

    for (let i = 0; i < plan.changes.length; i++) {
        const change = plan.changes[i];

        try {
            if (change.kind === 'delete') {
                const removed = await removeFile(change.relPath);
                chunksDeleted += removed;
                onProgress?.({
                    mode: 'catchup',
                    filesDone: i + 1,
                    filesTotal: total,
                    message: `🗑 ${change.relPath} (${removed} chunks removed)`,
                });
            } else {
                const result = await indexFile(change.relPath, { settings, root });
                chunksWritten += result.chunksWritten;
                chunksSkipped += result.chunksSkipped;
                chunksDeleted += result.chunksDeleted;
                filesScanned += 1;
                onProgress?.({
                    mode: 'catchup',
                    filesDone: i + 1,
                    filesTotal: total,
                    message: `✓ ${change.relPath} (+${result.chunksWritten} chunks)`,
                });
            }
        } catch (err) {
            onProgress?.({
                mode: 'catchup',
                filesDone: i + 1,
                filesTotal: total,
                message: `✗ ${change.relPath}: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }

    return { filesScanned, chunksWritten, chunksSkipped, chunksDeleted, elapsedMs: Date.now() - started };
}

export async function runCurrentCodeIndex(opts: {
    mode: 'full' | 'catchup';
    inspection?: CodeIndexInspection;
    onProgress?: (progress: CodeIndexProgress) => void;
}): Promise<CodeIndexRunResult> {
    const inspection = opts.inspection ?? await inspectCurrentCodeIndex();
    const mode = inspection.needsFreshIndex ? 'full' : opts.mode;

    if (mode === 'full') {
        const result = await runFullIndex(opts.onProgress);
        const totalChunks = await persistIndexState(
            inspection,
            await safeHeadCommit(inspection.identity.rootPath),
            result.chunksWritten,
        );

        return {
            mode,
            filesScanned: result.filesScanned,
            chunksWritten: result.chunksWritten,
            chunksSkipped: result.chunksSkipped,
            chunksDeleted: result.chunksDeleted,
            totalChunks,
            elapsedMs: result.elapsedMs,
            alias: inspection.existing?.alias ?? inspection.identity.alias,
            summary: `indexed ${result.filesScanned} files in ${(result.elapsedMs / 1000).toFixed(1)}s`,
        };
    }

    const catchupPlan = inspection.plan ?? await computeChangedFiles({
        repoRoot: inspection.identity.rootPath,
        lastIndexedCommit: inspection.existing?.lastIndexedCommit ?? '',
        lastIndexedAt: inspection.existing?.lastIndexedAt ?? 0,
    });
    const result = await runCatchupIndex(catchupPlan, opts.onProgress);
    const totalChunks = await persistIndexState(
        inspection,
        catchupPlan.headCommit ?? inspection.existing?.lastIndexedCommit ?? '',
        (inspection.existing?.chunksCount ?? 0) + result.chunksWritten,
    );

    return {
        mode,
        filesScanned: result.filesScanned,
        chunksWritten: result.chunksWritten,
        chunksSkipped: result.chunksSkipped,
        chunksDeleted: result.chunksDeleted,
        totalChunks,
        elapsedMs: result.elapsedMs,
        alias: inspection.existing?.alias ?? inspection.identity.alias,
        summary: result.filesScanned === 0
            ? 'Index is current.'
            : `catch-up: reindexed ${result.filesScanned} files in ${(result.elapsedMs / 1000).toFixed(1)}s`,
    };
}

export async function indexCodebase(): Promise<void> {
    console.log('kra-memory: starting full code index…');

    const result = await runCurrentCodeIndex({
        mode: 'full',
        onProgress: (progress) => {
            if (progress.message.startsWith('scanning workspace,')) {
                console.log(`kra-memory: ${progress.message}`);

                return;
            }
            if (progress.filesTotal <= 0 || !progress.message.startsWith('✓ ')) {
                return;
            }

            const filesDone = Math.min(progress.filesDone, progress.filesTotal);
            const pct = Math.floor((filesDone / progress.filesTotal) * 100);
            process.stdout.write(
                `  [${pct.toString().padStart(3)}%] ${filesDone}/${progress.filesTotal}  ${progress.message.slice(2)}\n`,
            );
        },
    });

    console.log('');
    console.log(`kra-memory: ${result.summary}`);
    console.log(`            ${result.chunksWritten} chunks written, ${result.chunksSkipped} unchanged, ${result.chunksDeleted} stale removed`);
    console.log(`            registry updated for '${result.alias}' (${result.totalChunks} total chunks)`);
}
