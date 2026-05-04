import blessed from 'blessed';
import { loadSettings } from '@/utils/common';
import { getDocChunksTable } from '@/AI/AIAgent/shared/memory/db';
import { docsCoordinatorJsPath, docsLiveProgressJsPath } from '@/packagePaths';
import { crawl4aiVenvDir } from '@/filePaths';
import { createIPCClient, IPCsockets } from '../../../../../../eventSystem/ipc';
import {
    installCrawl4ai,
    isCrawl4aiInstalled,
} from '@/AI/AIAgent/commands/docsSetup';
import {
    coordinatorAlive,
    readSnapshot,
} from '@/AI/AIAgent/shared/docs/liveProgressScreen';
import { runInherit } from '@/UI/dashboard/screen';
import type { DocsSettings, DocsSource } from '@/types/settingsTypes';
import type { DocsSourceRequest } from '@/AI/AIAgent/shared/docs/types';
import {
    attachVerticalNavigation,
    createDashboardList,
    createDashboardTextPanel,
    escTag,
    modalChoice,
    modalConfirm,
} from '@/UI/dashboard';
import type { MemorySectionHandle } from './findingsRevisits';

interface Item {
    key: string;
    label: string;
    source?: DocsSource;
}

export function mountDocsSourcesSection(opts: {
    screen: blessed.Widgets.Screen;
    parent: blessed.Widgets.BoxElement;
    setStatus: (text: string) => void;
}): MemorySectionHandle {
    const { screen, parent, setStatus } = opts;

    const list = createDashboardList(parent, {
        label: 'docs sources',
        top: 0,
        left: 0,
        width: '50%',
        height: '100%',
        borderColor: 'cyan',
        tags: true,
        keys: false,
        vi: false,
        mouse: true,
    });

    const details = createDashboardTextPanel(parent, {
        label: 'details',
        top: 0,
        left: '50%',
        width: '50%',
        height: '45%',
        borderColor: 'yellow',
        tags: true,
    });

    const live = blessed.box({
        parent,
        top: '45%',
        left: '50%',
        width: '50%',
        height: '55%',
        border: 'line',
        label: ' live crawl status ',
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        vi: true,
        mouse: true,
        style: { border: { fg: 'magenta' } },
    });

    let items: Item[] = [];
    let mode: 'main' | 'sources' = 'main';
    let pollTimer: NodeJS.Timeout | null = null;

    function keymapText(): string {
        return '{cyan-fg}enter{/cyan-fg} action · {cyan-fg}r{/cyan-fg} reload';
    }

    function flash(msg: string, color = 'green'): void {
        setStatus(`{${color}-fg}${escTag(msg)}{/${color}-fg}`);
        setTimeout(() => setStatus(keymapText()), 1400).unref();
    }

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
        } catch {
            // table may not exist yet
        }

        return counts;
    }

    async function buildMainItems(): Promise<Item[]> {
        const liveActive = (await coordinatorAlive()) || (await readSnapshot()) !== null;

        return [
            { key: 'setup', label: isCrawl4aiInstalled() ? 'Re-install Crawl4AI venv' : 'Setup Crawl4AI venv' },
            { key: 'list-sources', label: 'List configured sources' },
            { key: 'crawl-all', label: 'Re-index all sources' },
            { key: 'progress', label: liveActive ? 'Live crawl progress' : 'Live crawl progress (no active crawl)' },
            { key: 'stop', label: liveActive ? 'Stop coordinator' : 'Stop coordinator (not running)' },
        ];
    }

    async function buildSourceItems(): Promise<Item[]> {
        const cfg = await loadDocsSettings();
        const counts = await chunkCountsByAlias();
        const out: Item[] = [];

        if (cfg?.sources) {
            for (const src of cfg.sources) {
                const count = counts.get(src.alias) ?? 0;
                const depth = src.maxDepth ?? '∞';
                const maxPages = src.maxPages ?? '∞';
                const label = `${src.alias.padEnd(22)} ${String(count).padStart(5)} chunks  ·  depth=${depth}  ·  maxPages=${maxPages}`;
                out.push({ key: `source:${src.alias}`, label, source: src });
            }
        }

        out.push({ key: 'back', label: '← Back' });

        return out;
    }

    async function refreshList(): Promise<void> {
        items = mode === 'main' ? await buildMainItems() : await buildSourceItems();
        list.setItems(items.map((item) => item.label));
        list.select(0);
        renderDetails();
        screen.render();
    }

    function selectedItem(): Item | undefined {
        const idx = (list as unknown as { selected: number }).selected || 0;

        return items[idx];
    }

    function moveListBy(delta: number): void {
        if (items.length === 0) return;
        const current = (list as unknown as { selected?: number }).selected ?? 0;
        const next = Math.max(0, Math.min(items.length - 1, current + delta));
        list.select(next);
        renderDetails();
        screen.render();
    }

    function renderSourceDetails(src: DocsSource): string {
        return [
            `{cyan-fg}alias{/cyan-fg}        ${escTag(src.alias)}`,
            `{cyan-fg}url{/cyan-fg}          ${escTag(src.url)}`,
            `{cyan-fg}description{/cyan-fg}  ${escTag(src.description ?? '(none)')}`,
            `{cyan-fg}mode{/cyan-fg}         ${escTag(src.mode ?? '(auto)')}`,
            `{cyan-fg}maxDepth{/cyan-fg}     ${src.maxDepth ?? '∞'}`,
            `{cyan-fg}maxPages{/cyan-fg}     ${src.maxPages ?? '∞'}`,
            `{cyan-fg}concurrency{/cyan-fg}  ${src.concurrency ?? '(default)'}`,
            `{cyan-fg}pageTimeout{/cyan-fg}  ${src.pageTimeoutMs ?? '(default)'} ms`,
            `{cyan-fg}include{/cyan-fg}      ${escTag((src.includePatterns ?? []).join(', ') || '(all)')}`,
            `{cyan-fg}exclude{/cyan-fg}      ${escTag((src.excludePatterns ?? []).join(', ') || '(none)')}`,
        ].join('\n');
    }

    function renderDetails(): void {
        const item = selectedItem();
        if (!item) {
            details.setContent('');

            return;
        }
        if (item.source) {
            details.setContent(renderSourceDetails(item.source));

            return;
        }

        details.setContent([
            `{cyan-fg}action{/cyan-fg} ${escTag(item.label)}`,
            '',
            mode === 'main'
                ? '{gray-fg}Open source list to run per-source actions (re-index / drop chunks / details).{/gray-fg}'
                : '{gray-fg}Select a source for actions, or Back to return to the main menu.{/gray-fg}',
        ].join('\n'));
    }

    async function setupAction(): Promise<void> {
        const installed = isCrawl4aiInstalled();
        const message = installed
            ? `Re-install Crawl4AI into ${crawl4aiVenvDir}?\nThis will redownload ~507 MB of dependencies and headless Chromium.`
            : `Install Crawl4AI into ${crawl4aiVenvDir}?\nThis will download ~507 MB (Python deps ~318 MB, headless Chromium ~189 MB).`;

        const ok = await modalConfirm(screen, 'Crawl4AI setup', message);
        if (!ok) return;

        const result = await installCrawl4ai({ force: installed });
        if (result.kind === 'installed') {
            flash(`installed under ${result.venvDir}`);
        } else if (result.kind === 'already-installed') {
            flash(`already installed at ${result.venvDir}`, 'yellow');
        } else {
            flash(`install failed: ${result.message}`, 'red');
        }
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
        } catch {
            return 0;
        }
    }

    async function crawlSources(sources: DocsSource[], opts: { bypassIncremental: boolean }): Promise<void> {
        if (!isCrawl4aiInstalled()) {
            flash('Crawl4AI is not installed yet', 'yellow');

            return;
        }
        if (sources.length === 0) return;

        const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
        try {
            await client.ensureServerRunning(docsCoordinatorJsPath);
        } catch (err) {
            flash(`Failed to start docs coordinator: ${(err as Error).message}`, 'red');

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
            errors.length ? errors.map((e) => ` - ${e}`).join('\n') : 'No errors.',
        ].join('\n');

        flash(summary, errors.length ? 'yellow' : 'green');
    }

    async function crawlAllAction(): Promise<void> {
        const cfg = await loadDocsSettings();
        if (!cfg?.sources || cfg.sources.length === 0) {
            flash('No sources configured under [[ai.docs.sources]]', 'yellow');

            return;
        }
        if (cfg.enabled === false) {
            flash('[ai.docs] is disabled in settings.toml', 'yellow');

            return;
        }

        const proceed = await modalConfirm(screen, 'Re-index all', `Re-index all ${cfg.sources.length} source(s)?`);
        if (!proceed) return;

        const bypass = await modalConfirm(
            screen,
            'Incremental cache',
            'Bypass the incremental cache (full re-index)?\n\nyes = re-fetch every page\nno = skip unchanged pages',
        );

        await crawlSources(cfg.sources, { bypassIncremental: bypass });
    }

    async function sourceActions(src: DocsSource): Promise<void> {
        const action = await modalChoice(screen, src.alias, [
            'Re-index this source',
            'Drop indexed chunks for this source',
            'Show source details',
        ]);
        if (action.value === null) return;

        if (action.value === 'Re-index this source') {
            const bypass = await modalConfirm(
                screen,
                'Incremental cache',
                'Bypass incremental cache (full re-index)?\n\nyes = re-fetch every page\nno = skip unchanged pages',
            );
            await crawlSources([src], { bypassIncremental: bypass });

            return;
        }

        if (action.value === 'Drop indexed chunks for this source') {
            const ok = await modalConfirm(screen, 'Drop chunks', `Delete every doc_chunks row where sourceAlias='${src.alias}'?`);
            if (!ok) return;
            const removed = await dropChunksForSource(src.alias);
            flash(`Removed ${removed} chunk(s) for '${src.alias}'`);

            return;
        }

        details.setContent(renderSourceDetails(src));
        screen.render();
    }

    async function stopCoordinatorAction(): Promise<void> {
        const ok = await modalConfirm(screen, 'Stop coordinator', 'Send shutdown-request to the docs coordinator?');
        if (!ok) return;

        const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
        try {
            await client.emit(JSON.stringify({ type: 'shutdown-request' }));
            flash('Shutdown request sent. Coordinator will exit after in-flight work completes.');
        } catch (err) {
            flash(`Coordinator does not appear to be running: ${(err as Error).message}`, 'yellow');
        }
    }

    async function updateLivePane(): Promise<void> {
        const snapshot = await readSnapshot();
        const alive = await coordinatorAlive();
        if (!snapshot) {
            live.setContent(alive
                ? '{yellow-fg}coordinator running (no snapshot yet){/yellow-fg}'
                : '{gray-fg}no active crawl{/gray-fg}');
            screen.render();

            return;
        }

        const queued = snapshot.sources.filter((source) => source.phase === 'queued').length;
        const active = snapshot.sources.filter((source) => source.phase === 'crawling' || source.phase === 'embedding');
        const done = snapshot.sources.filter((source) => source.phase === 'done').length;
        const failed = snapshot.sources.filter((source) => source.phase === 'error').length;
        const lines = [
            `{cyan-fg}coordinator{/cyan-fg} ${alive ? '{green-fg}alive{/green-fg}' : '{yellow-fg}offline{/yellow-fg}'}`,
            `{cyan-fg}queued{/cyan-fg} ${queued}`,
            `{cyan-fg}active{/cyan-fg} ${active.length}`,
            `{cyan-fg}completed{/cyan-fg} ${done}`,
            `{cyan-fg}failed{/cyan-fg} ${failed}`,
            '',
            ...active.slice(0, 12).map((source) =>
                `{yellow-fg}•{/yellow-fg} ${escTag(source.alias)}  p=${source.pagesDone}/${source.pagesTotal || '?'}  ${escTag(source.lastUrl ?? '')}`),
        ];

        live.setContent(lines.join('\n'));
        screen.render();
    }

    async function runSelected(): Promise<void> {
        const item = selectedItem();
        if (!item) return;

        if (mode === 'main') {
            if (item.key === 'setup') await setupAction();
            else if (item.key === 'list-sources') {
                mode = 'sources';
                await refreshList();
                flash('select a source for actions');
            }
            else if (item.key === 'crawl-all') await crawlAllAction();
            else if (item.key === 'progress') {
                const liveActive = (await coordinatorAlive()) || (await readSnapshot()) !== null;
                if (liveActive) {
                    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                    try {
                        await runInherit(process.execPath, [docsLiveProgressJsPath], screen);
                    } finally {
                        pollTimer = setInterval(() => { void updateLivePane(); }, 500);
                    }
                    await updateLivePane();
                } else {
                    await updateLivePane();
                    flash('no active crawl yet — start one with "Re-index all sources"');
                }
            }
            else if (item.key === 'stop') await stopCoordinatorAction();

            await refreshList();

            return;
        }

        if (item.key === 'back') {
            mode = 'main';
            await refreshList();

            return;
        }

        if (item.source) {
            await sourceActions(item.source);
            await refreshList();
        }
    }

    list.on('select item', () => {
        renderDetails();
        screen.render();
    });

    attachVerticalNavigation(list as unknown as blessed.Widgets.BlessedElement & {
        key: (keys: string[] | string, handler: () => void) => unknown;
    }, {
        moveBy: moveListBy,
        top: () => {
            if (items.length === 0) return;
            list.select(0);
            renderDetails();
            screen.render();
        },
        bottom: () => {
            if (items.length === 0) return;
            list.select(items.length - 1);
            renderDetails();
            screen.render();
        },
    });

    list.key(['enter'], async () => {
        await runSelected();
        list.focus();
    });

    list.key(['r'], async () => {
        await refreshList();
        await updateLivePane();
        flash('reloaded');
    });

    void refreshList().then(async () => {
        await updateLivePane();
        setStatus(keymapText());
        list.focus();
    });

    pollTimer = setInterval(() => {
        void updateLivePane();
    }, 500);

    return {
        destroy: () => {
            if (pollTimer) clearInterval(pollTimer);
            list.destroy();
            details.destroy();
            live.destroy();
        },
        focus: () => list.focus(),
        panels: [
            { el: list, name: 'sources', color: 'cyan' },
            { el: details, name: 'details', color: 'yellow' },
            { el: live, name: 'live', color: 'magenta' },
        ],
        keymap: keymapText,
    };
}
