import * as os from 'os';
import * as path from 'path';
import { execCommand } from '@/utils/bashHelper';
import {
    type ListDetailDashboardApi,
    createListDetailDashboard,
    escTag,
    modalConfirm,
    theme,
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
    files: theme.file('FILES'),
    dirs: theme.dir('DIRS'),
    content: theme.warn('CONTENT'),
};

function renderStatsContent(allResults: GrepResult[], isSearching: boolean): string {
    if (allResults.length === 0) {
        return isSearching ? theme.warn('searching…') : theme.dim('no results');
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

    let out = `${theme.label('total   ')} ${theme.count(allResults.length)}` +
        `  ${theme.dim(`(${files} files, ${dirs} dirs)`)}`;
    if (selected > 0) out += `\n${theme.label('selected')} ${theme.count(selected)}`;
    out += `\n\n${theme.section('by extension')}\n`;
    out += topExt
        .map(([e, n]) => `  ${theme.file(escTag(e).padEnd(extPad))}  ${theme.count(n)}`)
        .join('\n');
    out += `\n\n${theme.section('by top dir')}\n`;
    out += topDirs
        .map(([d, n]) => `  ${theme.path(escTag(d.slice(0, dirPad)).padEnd(dirPad))}  ${theme.count(n)}`)
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
        const q = lastQuery ? `  ${theme.label('query')} ${theme.value(escTag(lastQuery))}` : '';
        const count = allResults.length > 0 ? `  ${theme.label('results')} ${theme.count(displayed.length)}` : '';
        const status = isSearching ? `  ${theme.warn('searching…')}` : '';
        const selCount = allResults.filter((r) => r.selected).length;
        const selTag = selCount > 0 ? `  ${theme.selected(`[${selCount} selected]`)}` : '';
        return ` ${theme.title('◆ grep')}` +
            `  ${theme.dim('mode')} ${MODE_LABEL[mode]}` +
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
                    return theme.dim('loading…');
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
                    return theme.dim('loading…');
                },
            },
            {
                label: 'stats',
                focusName: 'stats',
                initialContent: theme.dim('no results'),
                paint: () => renderStatsContent(allResults, isSearching),
            },
        ],
        keymapText: () =>
            `${theme.key('enter')} search/nvim   ` +
            `${theme.key('f')} files   ` +
            `${theme.key('d')} dirs   ` +
            `${theme.key('c')} content   ` +
            `${theme.key('x')} delete   ` +
            `${theme.key('space')} select   ` +
            `${theme.key('X')} del selected   ` +
            `${theme.key('y')} copy path   ` +
            `${theme.key('s')}/${theme.key('/')} search   ` +
            `${theme.key('q')} quit`,
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
