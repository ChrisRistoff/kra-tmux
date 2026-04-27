/**
 * Startup indexing flow: prompt the user whether to enable code search,
 * bring the local index up to date if so, stream progress to the Neovim
 * modal, and report whether `semantic_search` should be exposed for this
 * agent session.
 *
 * Sequence on launch:
 *   1. Identify the repo (git origin / top-level path).
 *   2. Show a Yes/No modal in Neovim.
 *   3. If "no" — return `{ semanticSearchEnabled: false }`. The agent will
 *      drop `semantic_search` from its tool list and from the MCP exposure.
 *   4. If "yes" — load the registry entry. If no entry exists or the repo
 *      has never been indexed, run a full `reindexAll`. Otherwise compute
 *      a catch-up plan (git diff vs `lastIndexedCommit`, or mtime fallback)
 *      and reindex only the changed files. Above
 *      `CATCHUP_FULL_REINDEX_THRESHOLD` ask whether to fall back to a full
 *      reindex.
 *   5. Show progress in a Neovim floating tab. Each indexed file is
 *      appended live. The modal stays open until the user dismisses it.
 *   6. Persist the new `lastIndexedCommit` / `lastIndexedAt` /
 *      `chunksCount` to the registry.
 */

import type * as neovim from 'neovim';
import { computeChangedFiles, CATCHUP_FULL_REINDEX_THRESHOLD } from '@/AI/AIAgent/shared/memory/catchup';
import {
    getRepoIdentity,
    getRegistryEntry,
    upsertRegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import { indexFile, reindexAll, removeFile, workspaceRoot } from '@/AI/AIAgent/shared/memory/indexer';
import { countCodeChunks } from '@/AI/AIAgent/shared/memory/db';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import { execCommand } from '@/utils/bashHelper';
import { handleAgentUserInput } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';

export interface StartupIndexingResult {
    semanticSearchEnabled: boolean;
}

interface ProgressContext {
    nvimClient: neovim.NeovimClient;
}

async function safeHeadCommit(repoRoot: string): Promise<string> {
    try {
        const result = await execCommand(`git -C '${repoRoot.replace(/'/g, `'\\''`)}' rev-parse HEAD`);

        return result.stdout.trim();
    } catch {
        return '';
    }
}

async function waitForModalDismiss(nvimClient: neovim.NeovimClient): Promise<void> {
    return new Promise((resolve) => {
        const handler = (method: string): void => {
            if (method !== 'index_progress_dismissed') return;
            nvimClient.removeListener('notification', handler);
            resolve();
        };
        nvimClient.on('notification', handler);
    });
}

async function showProgressModal(ctx: ProgressContext, alias: string, totalFiles: number, mode: 'initial' | 'catchup'): Promise<void> {
    const channelId = await ctx.nvimClient.channelId;
    await updateAgentUi(ctx.nvimClient, 'show_index_progress_modal', [
        { channel_id: channelId, alias, total_files: totalFiles, mode },
    ]);
}

async function appendProgress(ctx: ProgressContext, line: string, filesDone: number, filesTotal: number): Promise<void> {
    await updateAgentUi(ctx.nvimClient, 'append_index_progress', [{ line, files_done: filesDone, files_total: filesTotal }]);
}

function formatProgressLine(filesDone: number, filesTotal: number, suffix: string): string {
    const pct = filesTotal > 0 ? Math.floor((filesDone / filesTotal) * 100) : 0;

    return `[${pct.toString().padStart(3)}%] ${filesDone}/${filesTotal}  ${suffix}`;
}

async function markDone(ctx: ProgressContext, summary: string): Promise<void> {
    await updateAgentUi(ctx.nvimClient, 'set_index_progress_done', [{ summary }]);
}

async function appendLine(ctx: ProgressContext, line: string): Promise<void> {
    await updateAgentUi(ctx.nvimClient, 'append_index_progress', [{ line }]);
}

async function runFullReindex(ctx: ProgressContext, alias: string): Promise<{ chunksWritten: number; filesScanned: number; elapsedMs: number }> {
    let lastFilesTotal = 0;
    let lastPath = '';
    await showProgressModal(ctx, alias, 0, 'initial');
    const result = await reindexAll({
        onProgress: (p) => {
            lastFilesTotal = p.filesTotal;
            if (p.phase === 'embedding' && p.currentPath && p.currentPath !== lastPath) {
                lastPath = p.currentPath;
                void appendProgress(ctx, formatProgressLine(p.filesDone + 1, p.filesTotal, `✓ ${p.currentPath}`), p.filesDone + 1, p.filesTotal);
            }
            if (p.phase === 'scanning') {
                void updateAgentUi(ctx.nvimClient, 'set_index_progress_total', [{ total_files: p.filesTotal }]);
            }
        },
    });
    void lastFilesTotal;

    return { chunksWritten: result.chunksWritten, filesScanned: result.filesScanned, elapsedMs: result.elapsedMs };
}

async function runCatchup(
    ctx: ProgressContext,
    alias: string,
    changes: { relPath: string; kind: 'index' | 'delete' }[],
): Promise<{ chunksWritten: number; filesScanned: number; elapsedMs: number }> {
    const started = Date.now();
    const total = changes.length;
    await showProgressModal(ctx, alias, total, 'catchup');
    const settings = await loadMemorySettings();
    const root = workspaceRoot();
    let chunksWritten = 0;
    let filesScanned = 0;

    if (total === 0) {
        await appendProgress(ctx, '— Nothing to catch up. Index is current.', 0, 0);

        return { chunksWritten: 0, filesScanned: 0, elapsedMs: Date.now() - started };
    }

    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        try {
            if (change.kind === 'delete') {
                const removed = await removeFile(change.relPath);
                await appendProgress(ctx, formatProgressLine(i + 1, total, `🗑  ${change.relPath} (${removed} chunks removed)`), i + 1, total);
            } else {
                const r = await indexFile(change.relPath, { settings, root });
                chunksWritten += r.chunksWritten;
                filesScanned += 1;
                await appendProgress(ctx, formatProgressLine(i + 1, total, `✓ ${change.relPath} (+${r.chunksWritten} chunks)`), i + 1, total);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await appendProgress(ctx, formatProgressLine(i + 1, total, `✗ ${change.relPath}: ${msg}`), i + 1, total);
        }
    }

    return { chunksWritten, filesScanned, elapsedMs: Date.now() - started };
}

export async function runStartupIndexingFlow(
    nvimClient: neovim.NeovimClient,
    cwd: string,
): Promise<StartupIndexingResult> {
    const settings = await loadMemorySettings();

    if (!settings.enabled) {
        return { semanticSearchEnabled: false };
    }

    const identity = await getRepoIdentity(cwd);
    const existing = await getRegistryEntry(identity.id);
    const aliasLabel = existing?.alias ?? identity.alias;

    const prompt = await handleAgentUserInput(
        nvimClient,
        `Enable code semantic_search for '${aliasLabel}'? This will ${existing ? 'catch the index up' : 'index the repo for the first time'}.`,
        ['Yes', 'No'],
        false,
    );

    const answer = prompt.answer.trim().toLowerCase();
    if (answer !== 'yes' && answer !== 'y') {
        return { semanticSearchEnabled: false };
    }

    const ctx: ProgressContext = { nvimClient };
    let summary = '';

    const dbChunkCount = await countCodeChunks().catch(() => 0);
    const needsFreshIndex = !existing?.lastIndexedAt || dbChunkCount === 0;

    if (needsFreshIndex) {
        const r = await runFullReindex(ctx, aliasLabel);
        const total = await countCodeChunks().catch(() => r.chunksWritten);
        await upsertRegistryEntry(identity.id, {
            alias: identity.alias,
            rootPath: identity.rootPath,
            lastIndexedCommit: await safeHeadCommit(identity.rootPath),
            lastIndexedAt: Date.now(),
            chunksCount: total,
        });
        await appendLine(ctx, '');
        await appendLine(ctx, `indexed ${r.filesScanned} files in ${(r.elapsedMs / 1000).toFixed(1)}s`);
        await appendLine(ctx, `${r.chunksWritten} chunks written`);
        await appendLine(ctx, `registry updated for '${identity.alias}' (${total} total chunks)`);
        summary = 'Done.';
    } else {
        const plan = await computeChangedFiles({
            repoRoot: identity.rootPath,
            lastIndexedCommit: existing.lastIndexedCommit,
            lastIndexedAt: existing.lastIndexedAt,
        });

        let useFullReindex = false;
        if (plan.exceedsThreshold) {
            const confirm = await handleAgentUserInput(
                nvimClient,
                `Catch-up would reindex ${plan.changes.length} files (>${CATCHUP_FULL_REINDEX_THRESHOLD}). Run a full reindex instead?`,
                ['Yes', 'No'],
                false,
            );
            const a = confirm.answer.trim().toLowerCase();
            useFullReindex = a === 'yes' || a === 'y';
        }

        if (useFullReindex) {
            const r = await runFullReindex(ctx, aliasLabel);
            const total = await countCodeChunks().catch(() => r.chunksWritten);
            await upsertRegistryEntry(identity.id, {
                alias: identity.alias,
                rootPath: identity.rootPath,
                lastIndexedCommit: await safeHeadCommit(identity.rootPath),
                lastIndexedAt: Date.now(),
                chunksCount: total,
            });
            await appendLine(ctx, '');
            await appendLine(ctx, `indexed ${r.filesScanned} files in ${(r.elapsedMs / 1000).toFixed(1)}s`);
            await appendLine(ctx, `${r.chunksWritten} chunks written`);
            await appendLine(ctx, `registry updated for '${identity.alias}' (${total} total chunks)`);
            summary = 'Done.';
        } else {
            const r = await runCatchup(ctx, aliasLabel, plan.changes);
            const total = await countCodeChunks().catch(() => existing.chunksCount + r.chunksWritten);
            await upsertRegistryEntry(identity.id, {
                alias: identity.alias,
                rootPath: identity.rootPath,
                lastIndexedCommit: plan.headCommit ?? existing.lastIndexedCommit,
                lastIndexedAt: Date.now(),
                chunksCount: total,
            });
            await appendLine(ctx, '');
            await appendLine(ctx, `catch-up: reindexed ${r.filesScanned} files in ${(r.elapsedMs / 1000).toFixed(1)}s`);
            await appendLine(ctx, `${r.chunksWritten} chunks written`);
            await appendLine(ctx, `registry updated for '${identity.alias}' (${total} total chunks)`);
            summary = 'Done.';
        }
    }

    await markDone(ctx, summary);
    await waitForModalDismiss(nvimClient);

    return { semanticSearchEnabled: true };
}
