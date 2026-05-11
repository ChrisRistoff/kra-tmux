/**
 * Startup indexing flow: bring every selected repo's local code-chunks
 * index up to date in parallel, stream progress to a single Neovim modal,
 * and report whether `semantic_search` should be exposed for this agent
 * session.
 *
 * Sequence on launch:
 *   1. Identify each selected repo (git origin / top-level path).
 *   2. Build a per-repo plan in parallel (fresh full reindex vs catch-up
 *      based on registry state).
 *   3. Show ONE combined progress modal whose total = sum of per-repo
 *      file counts. Each line is prefixed with `[<repoAlias>]` so the
 *      user can tell which repo a file belongs to.
 *   4. Run every repo's index work concurrently (Promise.all). I/O,
 *      chunking, git diff, and LanceDB writes overlap; embedding calls
 *      serialize through fastembed's shared model (mutex in embedder.ts).
 *   5. Persist registry entries for every repo, then mark the modal done
 *      and wait for the user to dismiss it.
 *
 * Per-repo opt-out (Yes/No) is gone: by getting this far the user has
 * already explicitly selected these repos in the picker, so we always
 * proceed. Anything they DON'T want indexed simply shouldn't be selected.
 */

import { computeChangedFiles, type CatchupChange } from '@/AI/AIAgent/shared/memory/catchup';
import {
    getRepoIdentity,
    getRegistryEntry,
    upsertRegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import { indexFile, listIndexableFiles, reindexAll, removeFile } from '@/AI/AIAgent/shared/memory/indexer';
import { countCodeChunks } from '@/AI/AIAgent/shared/memory/db';
import { computeRepoKey } from '@/AI/AIAgent/shared/memory/repoKey';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import type { MemorySettings } from '@/AI/AIAgent/shared/memory/types';
import { execCommand } from '@/utils/bashHelper';
import { updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import { handleAgentUserInput } from '@/AI/AIAgent/shared/utils/agentToolHook';
import type { AgentHost } from '@/AI/TUI/host/agentHost';

export interface StartupIndexingResult {
    semanticSearchEnabled: boolean;
}

interface ProgressContext {
    target: AgentHost;
}

async function safeHeadCommit(repoRoot: string): Promise<string> {
    try {
        const result = await execCommand(`git -C '${repoRoot.replace(/'/g, `'\\''`)}' rev-parse HEAD`);

        return result.stdout.trim();
    } catch {
        return '';
    }
}

async function waitForModalDismiss(_target: AgentHost): Promise<void> {
    // The TUI host's index-progress modal handles dismissal internally.
    return Promise.resolve();
}

async function showProgressModal(ctx: ProgressContext, alias: string, totalFiles: number, mode: 'initial' | 'catchup'): Promise<void> {
    await updateAgentUi(ctx.target, 'show_index_progress_modal', [
        { channel_id: 0, alias, total_files: totalFiles, mode },
    ]);
}

async function appendProgress(ctx: ProgressContext, line: string, filesDone: number, filesTotal: number): Promise<void> {
    await updateAgentUi(ctx.target, 'append_index_progress', [{ line, files_done: filesDone, files_total: filesTotal }]);
}

function formatProgressLine(filesDone: number, filesTotal: number, suffix: string): string {
    const pct = filesTotal > 0 ? Math.floor((filesDone / filesTotal) * 100) : 0;

    return `[${pct.toString().padStart(3)}%] ${filesDone}/${filesTotal}  ${suffix}`;
}

async function markDone(ctx: ProgressContext, summary: string): Promise<void> {
    await updateAgentUi(ctx.target, 'set_index_progress_done', [{ summary }]);
}

async function appendLine(ctx: ProgressContext, line: string): Promise<void> {
    await updateAgentUi(ctx.target, 'append_index_progress', [{ line }]);
}

interface RepoIndexingPlan {
    cwd: string;
    identity: { id: string; rootPath: string; alias: string };
    repoKey: string;
    aliasLabel: string;
    existing: Awaited<ReturnType<typeof getRegistryEntry>>;
    mode: 'fresh' | 'catchup';
    files: string[];
    changes: CatchupChange[];
    headCommit: string | null;
}

interface RepoExecutionResult {
    plan: RepoIndexingPlan;
    chunksWritten: number;
    filesScanned: number;
    elapsedMs: number;
    error?: string;
}

async function buildRepoPlan(cwd: string, settings: MemorySettings): Promise<RepoIndexingPlan> {
    const identity = await getRepoIdentity(cwd);
    const repoKey = computeRepoKey(identity.id);
    const existing = await getRegistryEntry(identity.id);
    const aliasLabel = existing?.alias ?? identity.alias;

    const dbChunkCount = await countCodeChunks(repoKey).catch(() => 0);
    const needsFreshIndex = !existing?.lastIndexedAt || dbChunkCount === 0;

    if (needsFreshIndex) {
        const files = await listIndexableFiles(identity.rootPath, settings).catch(() => []);

        return {
            cwd,
            identity,
            repoKey,
            aliasLabel,
            existing,
            mode: 'fresh',
            files,
            changes: [],
            headCommit: null,
        };
    }

    const catchup = await computeChangedFiles({
        repoRoot: identity.rootPath,
        lastIndexedCommit: existing.lastIndexedCommit,
        lastIndexedAt: existing.lastIndexedAt,
        repoKey,
    });

    return {
        cwd,
        identity,
        repoKey,
        aliasLabel,
        existing,
        mode: 'catchup',
        files: [],
        changes: catchup.changes,
        headCommit: catchup.headCommit,
    };
}

async function executeRepoPlan(
    plan: RepoIndexingPlan,
    settings: MemorySettings,
    onFileDone: (line: string) => void,
): Promise<RepoExecutionResult> {
    const started = Date.now();
    let chunksWritten = 0;
    let filesScanned = 0;

    if (plan.mode === 'fresh') {
        try {
            let lastPath = '';
            const result = await reindexAll({
                root: plan.identity.rootPath,
                repoKey: plan.repoKey,
                onProgress: (p) => {
                    if (p.phase === 'embedding' && p.currentPath && p.currentPath !== lastPath) {
                        lastPath = p.currentPath;
                        onFileDone(`✓ ${p.currentPath}`);
                    }
                },
            });

            return {
                plan,
                chunksWritten: result.chunksWritten,
                filesScanned: result.filesScanned,
                elapsedMs: Date.now() - started,
            };
        } catch (err) {
            return {
                plan,
                chunksWritten,
                filesScanned,
                elapsedMs: Date.now() - started,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    for (const change of plan.changes) {
        try {
            if (change.kind === 'delete') {
                const removed = await removeFile(change.relPath, plan.repoKey);
                onFileDone(`🗑  ${change.relPath} (${removed} chunks removed)`);
            } else {
                const r = await indexFile(change.relPath, {
                    settings,
                    root: plan.identity.rootPath,
                    repoKey: plan.repoKey,
                });
                chunksWritten += r.chunksWritten;
                filesScanned += 1;
                onFileDone(`✓ ${change.relPath} (+${r.chunksWritten} chunks)`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            onFileDone(`✗ ${change.relPath}: ${msg}`);
        }
    }

    return {
        plan,
        chunksWritten,
        filesScanned,
        elapsedMs: Date.now() - started,
    };
}

function planTotalFiles(plan: RepoIndexingPlan): number {
    return plan.mode === 'fresh' ? plan.files.length : plan.changes.length;
}

function summaryAlias(plans: RepoIndexingPlan[]): string {
    if (plans.length === 1) return plans[0].aliasLabel;
    const aliases = plans.map((p) => p.aliasLabel).join(', ');

    return `${plans.length} repos: ${aliases}`;
}

/**
 * Index every selected repo in parallel and stream progress to a single
 * Neovim modal. The modal stays open until the user dismisses it.
 */
export async function runMultiRepoIndexingFlow(
    target: AgentHost,
    repoCwds: string[],
): Promise<StartupIndexingResult> {
    const settings = await loadMemorySettings();

    if (!settings.enabled) {
        return { semanticSearchEnabled: false };
    }

    if (repoCwds.length === 0) {
        return { semanticSearchEnabled: false };
    }

    const plans = await Promise.all(repoCwds.map(async (cwd) => buildRepoPlan(cwd, settings)));
    const totalFiles = plans.reduce((sum, p) => sum + planTotalFiles(p), 0);
    const ctx: ProgressContext = { target };
    const aliasHeader = summaryAlias(plans);
    const mode: 'initial' | 'catchup' = plans.every((p) => p.mode === 'catchup') ? 'catchup' : 'initial';

    // Confirm with the user before kicking off any work. Single Yes/No covers
    // every selected repo — each repo's contribution to the workload is shown
    // in the question so the user knows what they're authorising.
    if (totalFiles > 0) {
        const planSummary = plans
            .map((p) => `• ${p.aliasLabel}: ${planTotalFiles(p)} ${p.mode === 'fresh' ? 'files (full reindex)' : 'changed files (catch-up)'}`)
            .join('\n');
        const question = `Index the following repos now?\n\n${planSummary}`;
        const { answer } = await handleAgentUserInput(target, question, ['Yes', 'No'], false);
        if (answer.trim().toLowerCase() !== 'yes') {
            return { semanticSearchEnabled: true };
        }
    }

    await showProgressModal(ctx, aliasHeader, totalFiles, mode);

    let aggregatedDone = 0;
    const noopPlans = plans.filter((p) => planTotalFiles(p) === 0);
    for (const p of noopPlans) {
        await appendProgress(ctx, `[${p.aliasLabel}] — nothing to index, up to date`, aggregatedDone, totalFiles);
    }

    const workPlans = plans.filter((p) => planTotalFiles(p) > 0);
    const results = await Promise.all(
        workPlans.map(async (plan) =>
            executeRepoPlan(plan, settings, (line) => {
                aggregatedDone += 1;
                void appendProgress(
                    ctx,
                    formatProgressLine(aggregatedDone, totalFiles, `[${plan.aliasLabel}] ${line}`),
                    aggregatedDone,
                    totalFiles,
                );
            }),
        ),
    );

    // Persist registry entries for every repo (including noop ones, so first-time
    // selection of a clean repo gets recorded).
    await Promise.all(
        plans.map(async (plan) => {
            const result = results.find((r) => r.plan === plan);
            const fallbackChunks = (plan.existing?.chunksCount ?? 0) + (result?.chunksWritten ?? 0);
            const total = await countCodeChunks(plan.repoKey).catch(() => fallbackChunks);
            const lastIndexedCommit =
                plan.mode === 'fresh' || !plan.headCommit
                    ? await safeHeadCommit(plan.identity.rootPath)
                    : plan.headCommit;

            await upsertRegistryEntry(plan.identity.id, {
                alias: plan.identity.alias,
                rootPath: plan.identity.rootPath,
                lastIndexedCommit,
                lastIndexedAt: Date.now(),
                chunksCount: total,
            });
        }),
    );

    await appendLine(ctx, '');
    for (const result of results) {
        const tag = result.error ? `✗ ${result.error}` : 'done';
        await appendLine(
            ctx,
            `[${result.plan.aliasLabel}] ${result.filesScanned} files, +${result.chunksWritten} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s (${tag})`,
        );
    }
    for (const p of noopPlans) {
        await appendLine(ctx, `[${p.aliasLabel}] index already current`);
    }

    await markDone(ctx, plans.length === 1 ? 'Done.' : `Done. Indexed ${plans.length} repos.`);
    await waitForModalDismiss(target);

    return { semanticSearchEnabled: true };
}

/**
 * Backwards-compatible single-repo entrypoint. New callers should prefer
 * `runMultiRepoIndexingFlow` with the full list of selected repos so the
 * UI can show one combined progress modal.
 */
export async function runStartupIndexingFlow(
    target: AgentHost,
    cwd: string,
): Promise<StartupIndexingResult> {
    return runMultiRepoIndexingFlow(target, [cwd]);
}
