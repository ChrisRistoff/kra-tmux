import blessed from 'blessed';
import path from 'path';
import * as lancedb from '@lancedb/lancedb';
import {
    loadRegistry,
    removeRegistryEntry,
    upsertRegistryEntry,
    type RegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import { computeRepoKey } from '@/AI/AIAgent/shared/memory/repoKey';
import { kraMemoryRepoRoot } from '@/filePaths';
import { inspectCurrentCodeIndex, runCurrentCodeIndex } from '@/AI/AIAgent/commands/indexCodebase';
import {
    attachVerticalNavigation,
    createDashboardList,
    createDashboardTextPanel,
    escTag,
    modalChoice,
    modalConfirm,
    modalText,
} from '@/UI/dashboard';
import type { MemorySectionHandle } from './findingsRevisits';

interface RepoState {
    repos: { id: string; entry: RegistryEntry }[];
    repoFiles: Record<string, { path: string; chunks: number }[]>;
}

interface RepoRow {
    id: string;
    entry: RegistryEntry;
}

export function mountIndexedReposSection(opts: {
    screen: blessed.Widgets.Screen;
    parent: blessed.Widgets.BoxElement;
    setStatus: (text: string) => void;
}): MemorySectionHandle {
    const { screen, parent, setStatus } = opts;

    const list = createDashboardList(parent, {
        label: 'indexed repositories',
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

    const files = blessed.box({
        parent,
        top: '45%',
        left: '50%',
        width: '50%',
        height: '55%',
        border: 'line',
        label: ' indexed files ',
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        vi: true,
        mouse: true,
        style: { border: { fg: 'magenta' } },
    });

    let state: RepoState = { repos: [], repoFiles: {} };

    function keymapText(): string {
        return '{cyan-fg}enter{/cyan-fg} actions · {cyan-fg}i{/cyan-fg} re-index · {cyan-fg}d{/cyan-fg} drop · {cyan-fg}R{/cyan-fg} reset baseline · {cyan-fg}r{/cyan-fg} reload';
    }

    function flash(text: string, color = 'green'): void {
        setStatus(`{${color}-fg}${escTag(text)}{/${color}-fg}`);
        setTimeout(() => setStatus(keymapText()), 1400).unref();
    }

    async function loadRepoFiles(entry: { repoKey?: string; rootPath: string; id?: string }): Promise<{ path: string; chunks: number }[]> {
        const repoKey = entry.repoKey ?? (entry.id ? computeRepoKey(entry.id) : computeRepoKey(entry.rootPath));
        const lanceRoot = path.join(kraMemoryRepoRoot(repoKey), 'lance');
        try {
            const db = await lancedb.connect(lanceRoot);
            const names = await db.tableNames();
            if (!names.includes('code_chunks')) return [];
            const table = await db.openTable('code_chunks');
            const rows = await table.query().select(['path']).limit(50_000).toArray();
            const counts = new Map<string, number>();
            for (const r of rows) {
                const p = String((r as { path?: unknown }).path ?? '');
                if (!p) continue;
                counts.set(p, (counts.get(p) ?? 0) + 1);
            }

            return Array.from(counts.entries())
                .map(([p, chunks]) => ({ path: p, chunks }))
                .sort((a, b) => a.path.localeCompare(b.path));
        } catch {
            return [];
        }
    }

    async function loadState(): Promise<void> {
        const reg = await loadRegistry();
        const repos = Object.keys(reg.repos)
            .map((id) => ({ id, entry: reg.repos[id] }))
            .sort((a, b) => a.entry.alias.localeCompare(b.entry.alias));

        const repoFiles: Record<string, { path: string; chunks: number }[]> = {};
        for (const r of repos) {
            repoFiles[r.id] = await loadRepoFiles(r.entry);
        }

        state = { repos, repoFiles };
    }

    function selectedRepo(): RepoRow | undefined {
        const idx = (list as unknown as { selected: number }).selected || 0;

        return state.repos[idx];
    }

    function renderList(): void {
        const items = state.repos.map((r) => ` {cyan-fg}❑{/cyan-fg} {white-fg}${escTag(r.entry.alias)}{/white-fg} {gray-fg}· ${r.entry.chunksCount} chunks{/gray-fg}`);
        list.setItems(items);
        list.select(0);
        refreshPanels();
        screen.render();
    }

    function moveListBy(delta: number): void {
        if (state.repos.length === 0) return;
        const current = (list as unknown as { selected?: number }).selected ?? 0;
        const next = Math.max(0, Math.min(state.repos.length - 1, current + delta));
        list.select(next);
        refreshPanels();
        screen.render();
    }

    function renderDetails(row?: RepoRow): string {
        if (!row) return '{gray-fg}(no indexed repositories){/gray-fg}';

        return [
            `{cyan-fg}alias{/cyan-fg}            ${escTag(row.entry.alias)}`,
            `{cyan-fg}id{/cyan-fg}               ${escTag(row.id)}`,
            `{cyan-fg}rootPath{/cyan-fg}         ${escTag(row.entry.rootPath)}`,
            `{cyan-fg}chunks{/cyan-fg}           ${row.entry.chunksCount}`,
            `{cyan-fg}lastIndexed{/cyan-fg}      ${row.entry.lastIndexedAt ? new Date(row.entry.lastIndexedAt).toISOString() : '(never)'}`,
            `{cyan-fg}lastCommit{/cyan-fg}       ${escTag(row.entry.lastIndexedCommit || '(none)')}`,
            '',
            '{gray-fg}enter actions · i re-index · d drop · R reset baseline{/gray-fg}',
        ].join('\n');
    }

    function renderFiles(row?: RepoRow): string {
        if (!row) return '';
        const rows = state.repoFiles[row.id] ?? [];
        if (rows.length === 0) {
            return '{gray-fg}(no indexed files for this repo){/gray-fg}';
        }
        const totalChunks = rows.reduce((sum, item) => sum + item.chunks, 0);
        const header = `{cyan-fg}{bold}${rows.length} file${rows.length === 1 ? '' : 's'}{/bold}{/cyan-fg}  {gray-fg}·{/gray-fg}  {yellow-fg}${totalChunks} chunks{/yellow-fg}\n\n`;

        return header + rows.map((f) => `  {yellow-fg}${String(f.chunks).padStart(3)}{/yellow-fg}  {white-fg}${escTag(f.path)}{/white-fg}`).join('\n');
    }

    function refreshPanels(): void {
        const row = selectedRepo();
        details.setContent(renderDetails(row));
        details.setScrollPerc(0);
        files.setContent(renderFiles(row));
        files.setScrollPerc(0);
    }

    async function reload(): Promise<void> {
        await loadState();
        renderList();
    }

    async function dropCodeChunksAt(entry: { repoKey?: string; rootPath: string; id?: string }): Promise<boolean> {
        const repoKey = entry.repoKey ?? (entry.id ? computeRepoKey(entry.id) : computeRepoKey(entry.rootPath));
        const lanceRoot = path.join(kraMemoryRepoRoot(repoKey), 'lance');
        try {
            const db = await lancedb.connect(lanceRoot);
            const names = await db.tableNames();
            if (!names.includes('code_chunks')) return false;
            await db.dropTable('code_chunks');

            return true;
        } catch {
            return false;
        }
    }

    async function reindexRepo(id: string, entry: RegistryEntry): Promise<void> {
        try {
            const inspection = await inspectCurrentCodeIndex();
            if (path.resolve(entry.rootPath) !== path.resolve(inspection.workspaceRoot)) {
                flash('can only re-index the current workspace', 'yellow');

                return;
            }

            let mode: 'full' | 'catchup' = inspection.needsFreshIndex ? 'full' : 'catchup';
            if (!inspection.needsFreshIndex && inspection.plan?.exceedsThreshold) {
                const useFull = await modalConfirm(
                    screen,
                    'Large re-index',
                    `Catch-up would reindex ${inspection.plan.changes.length} files. Run a full reindex instead?`,
                );
                if (useFull) mode = 'full';
            }

            files.setContent(`{yellow-fg}starting ${mode === 'full' ? 'full re-index' : 'catch-up'}...{/yellow-fg}`);
            screen.render();

            const result = await runCurrentCodeIndex({
                inspection,
                mode,
                onProgress: (progress) => {
                    const suffix = progress.filesTotal > 0
                        ? ` (${Math.min(progress.filesDone, progress.filesTotal)}/${progress.filesTotal})`
                        : '';
                    files.setContent(`{yellow-fg}${escTag(progress.message + suffix)}{/yellow-fg}`);
                    files.setScrollPerc(100);
                    screen.render();
                },
            });

            await reload();
            const idx = state.repos.findIndex((r) => r.id === id);
            if (idx >= 0) list.select(idx);
            refreshPanels();
            flash(result.summary);
        } catch (err) {
            flash(err instanceof Error ? err.message : String(err), 'red');
        }
    }

    async function repoActions(row: RepoRow): Promise<void> {
        const action = await modalChoice(screen, row.entry.alias, [
            'Re-index now',
            'Drop index (delete code_chunks + registry entry)',
            'Reset baseline (force full reindex on next launch)',
            'Rename alias',
        ]);
        if (action.value === null) return;

        if (action.value === 'Re-index now') {
            await reindexRepo(row.id, row.entry);

            return;
        }

        if (action.value === 'Drop index (delete code_chunks + registry entry)') {
            const ok = await modalConfirm(screen, 'Drop index', `Drop code_chunks for '${row.entry.alias}' AND remove registry entry? Long-term memories untouched.`);
            if (ok) {
                const dropped = await dropCodeChunksAt(row.entry);
                await removeRegistryEntry(row.id);
                await reload();
                flash(dropped ? 'dropped + removed' : 'no chunks; registry cleared');
            }

            return;
        }

        if (action.value === 'Reset baseline (force full reindex on next launch)') {
            const ok = await modalConfirm(screen, 'Reset baseline', `Clear lastIndexedCommit/lastIndexedAt for '${row.entry.alias}'?`);
            if (ok) {
                await upsertRegistryEntry(row.id, { lastIndexedCommit: '', lastIndexedAt: 0 });
                await reload();
                flash('baseline cleared');
            }

            return;
        }

        const name = await modalText(screen, `New alias for '${row.entry.alias}'`, row.entry.alias);
        if (name.value?.trim()) {
            await upsertRegistryEntry(row.id, { alias: name.value.trim() });
            await reload();
            flash('renamed');
        }
    }

    list.on('select item', () => {
        refreshPanels();
        screen.render();
    });

    attachVerticalNavigation(list as unknown as blessed.Widgets.BlessedElement & {
        key: (keys: string[] | string, handler: () => void) => unknown;
    }, {
        moveBy: moveListBy,
        top: () => {
            if (state.repos.length === 0) return;
            list.select(0);
            refreshPanels();
            screen.render();
        },
        bottom: () => {
            if (state.repos.length === 0) return;
            list.select(state.repos.length - 1);
            refreshPanels();
            screen.render();
        },
    });

    list.key(['enter'], async () => {
        const row = selectedRepo();
        if (!row) return;
        await repoActions(row);
        list.focus();
    });

    list.key(['i'], async () => {
        const row = selectedRepo();
        if (!row) {
            flash('no repository selected', 'yellow');

            return;
        }
        await reindexRepo(row.id, row.entry);
        list.focus();
    });

    list.key(['d'], async () => {
        const row = selectedRepo();
        if (!row) return;
        const ok = await modalConfirm(screen, 'Drop index', `Drop code_chunks for '${row.entry.alias}' AND remove registry entry?`);
        if (ok) {
            const dropped = await dropCodeChunksAt(row.entry);
            await removeRegistryEntry(row.id);
            await reload();
            flash(dropped ? 'dropped + removed' : 'registry cleared');
        }
        list.focus();
    });

    list.key(['S-r'], async () => {
        const row = selectedRepo();
        if (!row) return;
        const ok = await modalConfirm(screen, 'Reset baseline', `Clear lastIndexedCommit/lastIndexedAt for '${row.entry.alias}'?`);
        if (ok) {
            await upsertRegistryEntry(row.id, { lastIndexedCommit: '', lastIndexedAt: 0 });
            await reload();
            flash('baseline cleared');
        }
        list.focus();
    });

    list.key(['r'], async () => {
        await reload();
        flash('reloaded');
        list.focus();
    });

    void reload().then(() => {
        setStatus(keymapText());
        list.focus();
    });

    return {
        destroy: () => {
            list.destroy();
            details.destroy();
            files.destroy();
        },
        focus: () => list.focus(),
        panels: [
            { el: list, name: 'repos', color: 'cyan' },
            { el: details, name: 'details', color: 'yellow' },
            { el: files, name: 'files', color: 'magenta' },
        ],
        keymap: keymapText,
    };
}
