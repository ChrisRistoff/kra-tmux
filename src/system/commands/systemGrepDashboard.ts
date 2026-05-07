import * as os from 'os';
import * as path from 'path';
import { execCommand } from '@/utils/bashHelper';
import {
    type ListDetailDashboardApi,
    createListDetailDashboard,
    escTag,
    modalConfirm,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';
import {
    type GrepResult,
    type SearchMode,
    type StreamSearchHandle,
    loadContentPreviewWithMatches,
    loadMeta,
    loadPreview,
    renderRow,
    searchByNameStream,
    searchContentStream,
} from '@/system/utils/grepUtils';


// ─── Main dashboard ───────────────────────────────────────────────────────────

const MODE_LABEL: Record<SearchMode, string> = {
    files: '{green-fg}FILES{/green-fg}',
    dirs: '{blue-fg}DIRS{/blue-fg}',
    content: '{yellow-fg}CONTENT{/yellow-fg}',
};

function renderStatsContent(allResults: GrepResult[], isSearching: boolean): string {
    if (allResults.length === 0) {
        return isSearching ? '{gray-fg}searching…{/gray-fg}' : '{gray-fg}no results{/gray-fg}';
    }
    const byExt = new Map<string, number>();
    const byDir = new Map<string, number>();
    let files = 0;
    let dirs = 0;
    let selected = 0;
    for (const r of allResults) {
        if (r.type === 'dir') dirs++; else files++;
        if (r.selected) selected++;
        const ext = r.type === 'dir'
            ? '<dir>'
            : (path.extname(r.absPath).toLowerCase() || '<none>');
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        const rel = r.displayPath.replace(/^\.\//u, '');
        const topDir = rel.includes('/') ? rel.split('/')[0] : '.';
        byDir.set(topDir, (byDir.get(topDir) ?? 0) + 1);
    }
    const topExt = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topDirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const extPad = topExt.reduce((m, [e]) => Math.max(m, e.length), 0);
    const dirPad = Math.min(topDirs.reduce((m, [d]) => Math.max(m, d.length), 0), 24);

    let out = `{cyan-fg}total{/cyan-fg}    {yellow-fg}${allResults.length}{/yellow-fg}` +
        `  {gray-fg}(${files} files, ${dirs} dirs){/gray-fg}`;
    if (selected > 0) out += `\n{cyan-fg}selected{/cyan-fg} {yellow-fg}${selected}{/yellow-fg}`;
    out += `\n\n{cyan-fg}by extension{/cyan-fg}\n`;
    out += topExt
        .map(([e, n]) => `  {green-fg}${escTag(e).padEnd(extPad)}{/green-fg}  ${n}`)
        .join('\n');
    out += `\n\n{cyan-fg}by top dir{/cyan-fg}\n`;
    out += topDirs
        .map(([d, n]) => `  {magenta-fg}${escTag(d.slice(0, dirPad)).padEnd(dirPad)}{/magenta-fg}  ${n}`)
        .join('\n');

    return out;
}

export async function openGrepDashboard(): Promise<void> {
    const cwd = process.cwd();

    let mode: SearchMode = 'files';
    let lastQuery = '';
    let allResults: GrepResult[] = [];
    let displayed: GrepResult[] = [];
    let isSearching = false;
    const previewCache = new Map<string, string>();
    const metaCache = new Map<string, string>();
    const previewScroll = new Map<string, number>();
    let activeSearch: StreamSearchHandle | null = null;

    function headerText(): string {
        const q = lastQuery ? `  {cyan-fg}query{/cyan-fg} {white-fg}${escTag(lastQuery)}{/white-fg}` : '';
        const count = allResults.length > 0 ? `  {cyan-fg}results{/cyan-fg} {yellow-fg}${displayed.length}{/yellow-fg}` : '';
        const status = isSearching ? '  {yellow-fg}searching…{/yellow-fg}' : '';
        const selCount = allResults.filter((r) => r.selected).length;
        const selTag = selCount > 0 ? `  {yellow-fg}[${selCount} selected]{/yellow-fg}` : '';
        return ` {magenta-fg}{bold}◆ grep{/bold}{/magenta-fg}` +
            `  mode ${MODE_LABEL[mode]}` +
            q + count + selTag + status;
    }

    function runSearch(query: string, api: ListDetailDashboardApi<GrepResult>): void {
        if (activeSearch) {
            activeSearch.cancel();
            activeSearch = null;
        }

        lastQuery = query;
        isSearching = true;
        allResults = [];
        displayed = [];
        previewCache.clear();
        metaCache.clear();
        previewScroll.clear();
        api.setRows([]);
        api.refreshHeader();

        const onBatch = (batch: GrepResult[]): void => {
            for (const r of batch) allResults.push(r);
        };

        const handle = mode === 'files'
            ? searchByNameStream(query, 'f', cwd, onBatch)
            : mode === 'dirs'
                ? searchByNameStream(query, 'd', cwd, onBatch)
                : searchContentStream(query, cwd, onBatch);

        activeSearch = handle;

        void handle.done.then(() => {
            if (activeSearch !== handle) return;
            activeSearch = null;
            isSearching = false;
            displayed = allResults;
            api.setRows(displayed);
            api.refreshHeader();
            api.repaintDetails();
        });
    }

    await createListDetailDashboard<GrepResult>({
        title: 'kra-grep',
        initialRows: displayed,
        rowKey: (r) => r.absPath,
        renderListItem: (r) => renderRow(r, mode),
        listLabel: 'results',
        listFocusName: 'results',
        listWidth: '42%',
        listTags: true,
        headerContent: headerText,
        filter: {
            label: 'search query',
            mode: 'submit',
            onSubmit: (q, api) => {
                if (q.trim()) runSearch(q.trim(), api);
            },
        },
        detailPanels: [
            {
                label: 'preview',
                focusName: 'preview',
                paint: (r, ctx) => {
                    const cached = previewCache.get(r.absPath);
                    if (cached !== undefined) return cached;
                    const useContentPreview = mode === 'content' && r.type === 'file' && lastQuery !== '';
                    const promise: Promise<string | { content: string; firstMatchLine: number; totalLines: number; matchCount: number }> = useContentPreview
                        ? loadContentPreviewWithMatches(r.absPath, lastQuery)
                        : loadPreview(r, mode, lastQuery);
                    void promise.then((preview) => {
                        if (ctx.isStale()) return;
                        let previewText: string;
                        let scrollPerc = 0;
                        if (typeof preview === 'string') {
                            previewText = preview;
                        } else {
                            previewText = preview.content;
                            scrollPerc = preview.totalLines > 0
                                ? Math.max(0, Math.min(100, Math.floor((preview.firstMatchLine - 1) / preview.totalLines * 100) - 5))
                                : 0;
                            if (r.matchCount === 0 && preview.matchCount > 0) {
                                r.matchCount = preview.matchCount;
                                ctx.api.repaint();
                            }
                        }
                        previewCache.set(r.absPath, previewText);
                        previewScroll.set(r.absPath, scrollPerc);
                        ctx.api.repaintDetails();
                    });
                    return '{gray-fg}loading…{/gray-fg}';
                },
                scrollPerc: (r) => previewScroll.get(r.absPath) ?? 0,
            },
            {
                label: 'meta',
                focusName: 'meta',
                paint: (r, ctx) => {
                    const cached = metaCache.get(r.absPath);
                    if (cached !== undefined) return cached;
                    void loadMeta(r).then((v) => {
                        if (ctx.isStale()) return;
                        metaCache.set(r.absPath, v);
                        ctx.api.repaintDetails();
                    });
                    return '{gray-fg}loading…{/gray-fg}';
                },
            },
            {
                label: 'stats',
                focusName: 'stats',
                initialContent: '{gray-fg}no results{/gray-fg}',
                paint: () => renderStatsContent(allResults, isSearching),
            },
        ],
        keymapText: () =>
            `{cyan-fg}enter{/cyan-fg} search/nvim   ` +
            `{cyan-fg}f{/cyan-fg} files   ` +
            `{cyan-fg}d{/cyan-fg} dirs   ` +
            `{cyan-fg}c{/cyan-fg} content   ` +
            `{cyan-fg}x{/cyan-fg} delete   ` +
            `{cyan-fg}space{/cyan-fg} select   ` +
            `{cyan-fg}X{/cyan-fg} del selected   ` +
            `{cyan-fg}y{/cyan-fg} copy path   ` +
            `{cyan-fg}s{/cyan-fg}/{cyan-fg}/{/cyan-fg} search   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
        actions: [
            {
                keys: 'f',
                handler: (_r, api) => {
                    mode = 'files';
                    api.repaint();
                    api.refreshHeader();
                    api.shell.searchBox?.focus();
                    api.screen.render();
                },
            },
            {
                keys: 'd',
                handler: (_r, api) => {
                    mode = 'dirs';
                    api.repaint();
                    api.refreshHeader();
                    api.shell.searchBox?.focus();
                    api.screen.render();
                },
            },
            {
                keys: 'c',
                handler: (_r, api) => {
                    mode = 'content';
                    api.repaint();
                    api.refreshHeader();
                    api.shell.searchBox?.focus();
                    api.screen.render();
                },
            },
            {
                keys: 'enter',
                handler: async (r, api) => {
                    if (!r || r.type === 'dir') return;
                    await runInherit('nvim', [r.absPath], api.screen);
                },
            },
            {
                keys: 'y',
                handler: (r, api) => {
                    if (!r) return;
                    const cmd = os.platform() === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
                    execCommand(`echo ${JSON.stringify(r.absPath)} | ${cmd}`).catch(() => null);
                    api.flashHeader(`Copied: ${r.absPath}`);
                },
            },
            {
                keys: 'space',
                handler: (r, api) => {
                    if (!r) return;
                    r.selected = !r.selected;
                    api.repaint();
                    api.refreshHeader();
                    api.repaintDetails();
                },
            },
            {
                keys: 'x',
                handler: async (r, api) => {
                    if (!r) return;
                    const label = r.type === 'dir' ? 'Delete directory' : 'Delete file';
                    const msg = `${r.type === 'dir' ? 'Recursively delete' : 'Delete'} ${r.absPath}?`;
                    const ok = await modalConfirm(api.screen, label, msg);
                    if (!ok) return;
                    try {
                        const cmd = r.type === 'dir'
                            ? `rm -rf ${JSON.stringify(r.absPath)}`
                            : `rm -f ${JSON.stringify(r.absPath)}`;
                        await execCommand(cmd);
                        allResults = allResults.filter((res) => res.absPath !== r.absPath);
                        displayed = displayed.filter((res) => res.absPath !== r.absPath);
                        previewCache.delete(r.absPath);
                        metaCache.delete(r.absPath);
                        previewScroll.delete(r.absPath);
                        api.setRows(displayed);
                        api.refreshHeader();
                        api.repaintDetails();
                    } catch (e) {
                        api.flashHeader(`Delete failed: ${(e as Error).message}`);
                    }
                },
            },
            {
                keys: ['X', 'S-x'],
                handler: async (_r, api) => {
                    const targets = allResults.filter((row) => row.selected);
                    if (targets.length === 0) {
                        api.flashHeader('No items selected — use space to select');
                        return;
                    }
                    const ok = await modalConfirm(api.screen, 'Batch delete', `Delete ${targets.length} selected item(s)?`);
                    if (!ok) return;
                    const errors: string[] = [];
                    for (const row of targets) {
                        try {
                            const cmd = row.type === 'dir'
                                ? `rm -rf ${JSON.stringify(row.absPath)}`
                                : `rm -f ${JSON.stringify(row.absPath)}`;
                            await execCommand(cmd);
                            previewCache.delete(row.absPath);
                            metaCache.delete(row.absPath);
                            previewScroll.delete(row.absPath);
                        } catch (e) {
                            errors.push((e as Error).message);
                        }
                    }
                    const deleted = targets.length - errors.length;
                    allResults = allResults.filter((row) => !row.selected || errors.some((err) => row.absPath.includes(err)));
                    displayed = displayed.filter((row) => !row.selected || errors.some((err) => row.absPath.includes(err)));
                    allResults.forEach((row) => { row.selected = false; });
                    api.setRows(displayed);
                    api.refreshHeader();
                    api.repaintDetails();
                    api.flashHeader(errors.length > 0 ? `Deleted ${deleted}, ${errors.length} error(s)` : `Deleted ${deleted} item(s)`);
                },
            },
            {
                keys: 'r',
                handler: (_r, api) => {
                    if (lastQuery) runSearch(lastQuery, api);
                },
            },
            {
                keys: ['s', '/'],
                handler: (_r, api) => {
                    api.shell.searchBox?.focus();
                    api.screen.render();
                },
            },
        ],
    });
}
