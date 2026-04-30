/**
 * `kra ai docs` — interactive blessed UI for the docs (Crawl4AI) pipeline.
 *
 * One entry point that mirrors `manageMemory()`:
 *   - Setup Crawl4AI venv (or re-install)
 *   - List configured sources, with a per-source action submenu
 *     (Re-index this source, Drop indexed chunks, Show details)
 *   - Re-index all sources
 *   - Live crawl progress (polls docs-status.json every ~500 ms)
 *   - Stop coordinator
 *
 * The legacy verbs (`update-docs`, `docs setup|status|list|stop`) have
 * been removed — this menu is the only surface.
 */

import * as ui from '@/UI/generalUI';
import { menuChain, UserCancelled } from '@/UI/menuChain';
import { loadSettings } from '@/utils/common';
import { getDocChunksTable } from '@/AI/AIAgent/shared/memory/db';
import { docsCoordinatorJsPath } from '@/packagePaths';
import { crawl4aiVenvDir } from '@/filePaths';
import { createIPCClient, IPCsockets } from '../../../../eventSystem/ipc';
import {
    installCrawl4ai,
    isCrawl4aiInstalled,
} from './docsSetup';
import {
    showLiveProgress,
    coordinatorAlive,
    readSnapshot,
} from '@/AI/AIAgent/shared/docs/liveProgressScreen';
import type { DocsSettings, DocsSource } from '@/types/settingsTypes';
import type { DocsSourceRequest } from '@/AI/AIAgent/shared/docs/types';


async function loadDocsSettings(): Promise<DocsSettings | null> {
    const settings = await loadSettings();
    const cfg = settings.ai?.docs;
    if (!cfg) return null;

    return cfg;
}

async function chunkCountsByAlias(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    try {
        const { table } = await getDocChunksTable(null);
        if (!table) return counts;
        const rows = await table.query().select(['sourceAlias']).limit(100_000).toArray();
        for (const row of rows as Array<{ sourceAlias: string }>) {
            counts.set(row.sourceAlias, (counts.get(row.sourceAlias) ?? 0) + 1);
        }
    } catch { /* table may not exist yet */ }

    return counts;
}

// ============================================================================
// Top-level menu
// ============================================================================

export async function manageDocs(): Promise<void> {
    await menuChain()
        .step('action', async () => {
            const items: string[] = [];
            items.push(isCrawl4aiInstalled() ? 'Re-install Crawl4AI venv' : 'Setup Crawl4AI venv');
            items.push('List configured sources');
            items.push('Re-index all sources');

            const live = coordinatorAlive() || readSnapshot() !== null;
            items.push(live ? 'Live crawl progress' : 'Live crawl progress (no active crawl)');
            items.push(live ? 'Stop coordinator' : 'Stop coordinator (not running)');

            const choice = await ui.searchSelectAndReturnFromArray({
                itemsArray: items,
                prompt: 'kra-docs',
            });

            if (!choice) throw new UserCancelled();

            return choice;
        })
        .step('_', async ({ action }) => {
            if (action.startsWith('Setup') || action.startsWith('Re-install')) {
                await setupAction();
            } else if (action === 'List configured sources') {
                await listSourcesMenu();
            } else if (action === 'Re-index all sources') {
                await crawlAllAction();
            } else if (action.startsWith('Live crawl progress')) {
                if (action.includes('no active crawl')) {
                    await ui.showInfoScreen(
                        'Live progress',
                        'No active crawl. Start one via "Re-index all sources" or pick a source from the list.\n',
                    );
                } else {
                    await showLiveProgress();
                }
            } else if (action.startsWith('Stop coordinator')) {
                if (action.includes('not running')) {
                    await ui.showInfoScreen('Stop coordinator', 'Coordinator does not appear to be running.\n');
                } else {
                    await stopCoordinatorAction();
                }
            }

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

// ============================================================================
// Setup
// ============================================================================

async function setupAction(): Promise<void> {
    const installed = isCrawl4aiInstalled();
    const message = installed
        ? `Re-install Crawl4AI into ${crawl4aiVenvDir}?\nThis will redownload ~507 MB of dependencies and headless Chromium.`
        : `Install Crawl4AI into ${crawl4aiVenvDir}?\nThis will download ~507 MB (Python deps ~318 MB, headless Chromium ~189 MB).`;

    const ok = await ui.promptUserYesOrNo(message);
    if (!ok) return;

    console.log('');
    const result = await installCrawl4ai({ force: installed });
    console.log('');

    if (result.kind === 'installed') {
        await ui.showInfoScreen('Crawl4AI installed', `Installed under ${result.venvDir}\n\nYou can now crawl your configured sources.\n`);
    } else if (result.kind === 'already-installed') {
        await ui.showInfoScreen('Already installed', `Crawl4AI is already present at ${result.venvDir}.\n`);
    } else {
        await ui.showInfoScreen('Install failed', `Error: ${result.message}\n`);
    }
}

// ============================================================================
// List sources + per-source actions
// ============================================================================

async function listSourcesMenu(): Promise<void> {
    await menuChain()
        .step('pick', async () => {
            const cfg = await loadDocsSettings();
            if (!cfg?.sources || cfg.sources.length === 0) {
                await ui.showInfoScreen(
                    'No sources',
                    'No sources configured under [[ai.docs.sources]] in settings.toml.\nAdd at least one entry and re-run.\n',
                );
                throw new UserCancelled();
            }

            const counts = await chunkCountsByAlias();
            const labelToSource = new Map<string, DocsSource>();
            const labels: string[] = [];
            for (const src of cfg.sources) {
                const count = counts.get(src.alias) ?? 0;
                const depth = src.maxDepth ?? '\u221e';
                const max = src.maxPages ?? '\u221e';
                const label = `${src.alias.padEnd(22)} ${String(count).padStart(5)} chunks  \u00b7  depth=${depth}  \u00b7  maxPages=${max}`;
                labels.push(label);
                labelToSource.set(label, src);
            }

            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: labels,
                prompt: 'kra-docs sources',
            });

            if (!picked) throw new UserCancelled();
            const src = labelToSource.get(picked);
            if (!src) throw new UserCancelled();

            return src;
        })
        .step('_', async ({ pick }) => {
            await sourceActions(pick);

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function sourceActions(src: DocsSource): Promise<void> {
    await menuChain()
        .step('action', async () => {
            const action = await ui.searchSelectAndReturnFromArray({
                itemsArray: [
                    'Re-index this source',
                    'Drop indexed chunks for this source',
                    'Show source details',
                ],
                prompt: src.alias,
            });

            if (!action) throw new UserCancelled();

            return action;
        })
        .step('_', async ({ action }) => {
            if (action === 'Re-index this source') {
                const bypass = await ui.promptUserYesOrNo(
                    'Bypass the incremental cache (full re-index)?\n\n'
                    + 'yes = re-fetch every page, ignore the page-hash cache.\n'
                    + 'no  = skip pages whose content has not changed since the last index (recommended).',
                );
                await crawlSources([src], { bypassIncremental: bypass });

                return;
            }
            if (action.startsWith('Drop indexed chunks')) {
                const ok = await ui.promptUserYesOrNo(
                    `Delete every doc_chunks row where sourceAlias='${src.alias}'?\nNext crawl will re-index from scratch.`,
                );
                if (!ok) throw new UserCancelled();

                const removed = await dropChunksForSource(src.alias);
                await ui.showInfoScreen('Dropped chunks', `Removed ${removed} chunk(s) for '${src.alias}'.\n`);

                return;
            }
            if (action === 'Show source details') {
                const details = [
                    `alias:        ${src.alias}`,
                    `url:          ${src.url}`,
                    `description:  ${src.description ?? '(none)'}`,
                    `mode:         ${src.mode ?? '(auto)'}`,
                    `maxDepth:     ${src.maxDepth ?? '\u221e'}`,
                    `maxPages:     ${src.maxPages ?? '\u221e'}`,
                    `concurrency:  ${src.concurrency ?? '(default)'}`,
                    `pageTimeout:  ${src.pageTimeoutMs ?? '(default)'} ms`,
                    `include:      ${(src.includePatterns ?? []).join(', ') || '(all)'}`,
                    `exclude:      ${(src.excludePatterns ?? []).join(', ') || '(none)'}`,
                ].join('\n');
                await ui.showInfoScreen(src.alias, details + '\n');
                throw new UserCancelled();
            }
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function dropChunksForSource(alias: string): Promise<number> {
    try {
        const { table } = await getDocChunksTable(null);
        if (!table) return 0;
        const before = await table.countRows().catch(() => 0);
        const escaped = alias.replace(/'/g, "''");
        await table.delete(`sourceAlias = '${escaped}'`);
        const after = await table.countRows().catch(() => 0);

        return Math.max(0, before - after);
    } catch (err) {
        console.warn(`kra-docs: failed to drop chunks for ${alias}: ${(err as Error).message}`);

        return 0;
    }
}

// ============================================================================
// Crawl
// ============================================================================

async function crawlAllAction(): Promise<void> {
    const cfg = await loadDocsSettings();
    if (!cfg?.sources || cfg.sources.length === 0) {
        await ui.showInfoScreen('No sources', 'No sources configured under [[ai.docs.sources]].\n');

        return;
    }
    if (cfg.enabled === false) {
        await ui.showInfoScreen('Disabled', '[ai.docs] is disabled in settings.toml. Set `enabled = true` to re-index sources.\n');

        return;
    }

    const proceed = await ui.promptUserYesOrNo(
        `Re-index all ${cfg.sources.length} source(s)?`,
    );
    if (!proceed) return;

    const bypass = await ui.promptUserYesOrNo(
        'Bypass the incremental cache (full re-index)?\n\n'
        + 'yes = re-fetch every page, ignore the page-hash cache.\n'
        + 'no  = skip pages whose content has not changed since the last index (recommended).',
    );

    await crawlSources(cfg.sources, { bypassIncremental: bypass });
}

async function crawlSources(
    sources: DocsSource[],
    opts: { bypassIncremental: boolean },
): Promise<void> {
    if (!isCrawl4aiInstalled()) {
        await ui.showInfoScreen(
            'Crawl4AI not installed',
            'Crawl4AI is not installed yet. Run "Setup Crawl4AI venv" from the main menu first.\n',
        );

        return;
    }
    if (sources.length === 0) return;

    const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
    try {
        await client.ensureServerRunning(docsCoordinatorJsPath);
    } catch (err) {
        await ui.showInfoScreen('Coordinator failed', `Failed to start docs coordinator:\n${(err as Error).message}\n`);

        return;
    }

    let submitted = 0;
    const errors: string[] = [];
    for (const source of sources) {
        const msg: DocsSourceRequest = {
            type: 'source-enqueue',
            alias: source.alias,
            url: source.url,
            ...(source.maxDepth !== undefined ? { maxDepth: source.maxDepth } : {}),
            ...(source.maxPages !== undefined ? { maxPages: source.maxPages } : {}),
            ...(source.includePatterns !== undefined ? { includePatterns: source.includePatterns } : {}),
            ...(source.excludePatterns !== undefined ? { excludePatterns: source.excludePatterns } : {}),
            ...(source.mode !== undefined ? { mode: source.mode } : {}),
            ...(source.concurrency !== undefined ? { concurrency: source.concurrency } : {}),
            ...(source.pageTimeoutMs !== undefined ? { pageTimeoutMs: source.pageTimeoutMs } : {}),
            ...(opts.bypassIncremental ? { bypassIncremental: true } : {}),
        };
        try {
            await client.emit(JSON.stringify(msg));
            submitted++;
        } catch (err) {
            errors.push(`${source.alias}: ${(err as Error).message}`);
        }
    }

    const summary = [
        `Submitted ${submitted}/${sources.length} source(s) to the coordinator.`,
        '',
        errors.length ? 'Errors:\n' + errors.map((e) => '  - ' + e).join('\n') : 'No errors.',
        '',
        'Open "Live crawl progress" from the main menu to follow re-index progress.',
        '',
    ].join('\n');

    const watch = await ui.promptUserYesOrNo(summary + '\nOpen the live progress screen now?');
    if (watch) await showLiveProgress();
}

// ============================================================================
// Stop
// ============================================================================

async function stopCoordinatorAction(): Promise<void> {
    const ok = await ui.promptUserYesOrNo('Send shutdown-request to the docs coordinator?');
    if (!ok) return;

    const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
    try {
        await client.emit(JSON.stringify({ type: 'shutdown-request' }));
        await ui.showInfoScreen('Stop sent', 'Shutdown request sent. The coordinator will exit after in-flight work completes.\n');
    } catch (err) {
        await ui.showInfoScreen('Stop failed', `Coordinator does not appear to be running.\n\n${(err as Error).message}\n`);
    }
}

