import * as os from 'os';
import * as path from 'path';
import { execCommand } from '@/utils/bashHelper';
import {
    attachFocusCycleKeys,
    attachVerticalNavigation,
    awaitScreenDestroy,
    createDashboardScreen,
    createDashboardShell,
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

export async function openGrepDashboard(): Promise<void> {
    const cwd = process.cwd();

    let mode: SearchMode = 'files';
    let lastQuery = '';
    let allResults: GrepResult[] = [];
    let displayed: GrepResult[] = [];
    let currentIdx = -1;
    let loadSeq = 0;
    let isSearching = false;
    const previewCache = new Map<string, string>();
    const metaCache = new Map<string, string>();

    const screen = createDashboardScreen({ title: 'kra-grep' });

    const shell = createDashboardShell({
        screen,
        headerContent: '',
        listLabel: 'results',
        listFocusName: 'results',
        listWidth: '42%',
        listItems: [],
        listTags: true,
        search: {
            label: 'search query',
            width: '42%',
            inputOnFocus: true,
            keys: false,
        },
        detailPanels: [
            { label: 'preview', focusName: 'preview' },
            { label: 'meta', focusName: 'meta' },
            { label: 'stats', focusName: 'stats' },
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
    });

    const { header, list, ring } = shell;
    const searchBox = shell.searchBox!;
    const [previewPanel, metaPanel, statsPanel] = shell.detailPanels;

    // ── Header ────────────────────────────────────────────────────────────────

    const modeLabel: Record<SearchMode, string> = {
        files: '{green-fg}FILES{/green-fg}',
        dirs: '{blue-fg}DIRS{/blue-fg}',
        content: '{yellow-fg}CONTENT{/yellow-fg}',
    };

    function setHeader(): void {
        const q = lastQuery ? `  {cyan-fg}query{/cyan-fg} {white-fg}${escTag(lastQuery)}{/white-fg}` : '';
        const count = allResults.length > 0 ? `  {cyan-fg}results{/cyan-fg} {yellow-fg}${displayed.length}{/yellow-fg}` : '';
        const status = isSearching ? '  {yellow-fg}searching…{/yellow-fg}' : '';
        const selCount = allResults.filter((r) => r.selected).length;
        const selTag = selCount > 0 ? `  {yellow-fg}[${selCount} selected]{/yellow-fg}` : '';
        header.setContent(
            ` {magenta-fg}{bold}◆ grep{/bold}{/magenta-fg}` +
            `  mode ${modeLabel[mode]}` +
            q + count + selTag + status,
        );
    }

    setHeader();
    renderStats();

    // ── List rendering ────────────────────────────────────────────────

    function renderListItems(): void {
        list.setItems(displayed.map((r) => renderRow(r, mode)));
    }

    function renderStats(): void {
        if (allResults.length === 0) {
            statsPanel.setContent(isSearching
                ? '{gray-fg}searching…{/gray-fg}'
                : '{gray-fg}no results{/gray-fg}');

            return;
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

        statsPanel.setContent(out);
    }

    function flashHeader(msg: string): void {
        const prev = header.content;
        header.setContent(` {yellow-fg}${escTag(msg)}{/yellow-fg}`);
        screen.render();
        setTimeout(() => { header.setContent(prev); screen.render(); }, 1800);
    }

    function showNoResults(): void {
        previewPanel.setContent('{gray-fg}no results{/gray-fg}');
        metaPanel.setContent('');
    }

    // ── Search (streaming) ─────────────────────────────────────────────────────

    let activeSearch: StreamSearchHandle | null = null;

    function runSearch(query: string): void {
        if (activeSearch) {
            activeSearch.cancel();
            activeSearch = null;
        }

        lastQuery = query;
        isSearching = true;
        currentIdx = -1;
        allResults = [];
        displayed = [];
        previewCache.clear();
        metaCache.clear();

        // Show "searching…" but DO NOT redraw the list while results stream in.
        // rg -l completes in tens of ms even on huge repos, and repeated
        // setItems on a tagged list is what made this feel "painfully slow".
        list.setItems([]);
        setHeader();
        previewPanel.setContent('{gray-fg}searching…{/gray-fg}');
        metaPanel.setContent('');
        renderStats();
        screen.render();

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
            renderListItems();
            setHeader();
            renderStats();
            if (displayed.length === 0) {
                showNoResults();
                screen.render();
            } else {
                currentIdx = 0;
                list.select(0);
                screen.render();
                void selectIndex(0);
            }
        });
    }

    // ── Selection / preview ───────────────────────────────────────────────────

    async function selectIndex(i: number): Promise<void> {
        if (i < 0 || i >= displayed.length) return;
        currentIdx = i;
        const r = displayed[i];
        const seq = ++loadSeq;

        previewPanel.setContent('{gray-fg}loading…{/gray-fg}');
        metaPanel.setContent('');
        screen.render();

        const cachedPreview = previewCache.get(r.absPath);
        const cachedMeta = metaCache.get(r.absPath);

        const useContentPreview = mode === 'content' && r.type === 'file' && lastQuery !== '';
        const previewPromise: Promise<string | { content: string; firstMatchLine: number; totalLines: number; matchCount: number }> = cachedPreview !== undefined
            ? Promise.resolve(cachedPreview)
            : useContentPreview
                ? loadContentPreviewWithMatches(r.absPath, lastQuery)
                : loadPreview(r, mode, lastQuery);
        const [preview, meta] = await Promise.all([
            previewPromise,
            cachedMeta !== undefined ? Promise.resolve(cachedMeta) : loadMeta(r),
        ]);

        if (seq !== loadSeq) return;

        let previewText: string;
        let scrollPerc = 0;
        if (typeof preview === 'string') {
            previewText = preview;
        } else {
            previewText = preview.content;
            scrollPerc = preview.totalLines > 0
                ? Math.max(0, Math.min(100, Math.floor((preview.firstMatchLine - 1) / preview.totalLines * 100) - 5))
                : 0;
            // backfill matchCount so the list/stats reflect actual hits
            if (r.matchCount === 0 && preview.matchCount > 0) {
                r.matchCount = preview.matchCount;
                renderListItems();
                list.select(currentIdx);
                renderStats();
            }
        }

        previewCache.set(r.absPath, previewText);
        metaCache.set(r.absPath, meta);

        previewPanel.setContent(previewText);
        previewPanel.setScrollPerc(scrollPerc);
        metaPanel.setContent(meta);
        screen.render();
    }

    function current(): GrepResult | undefined {
        return currentIdx >= 0 ? displayed[currentIdx] : undefined;
    }

    // ── Vertical nav ─────────────────────────────────────────────────────────

    list.on('select item', (_item: unknown, idx: number) => {
        void selectIndex(idx);
    });

    attachVerticalNavigation(list, {
        moveBy: (delta) => {
            if (displayed.length === 0) return;
            const cur = currentIdx >= 0 ? currentIdx : 0;
            let target = cur + delta;
            if (target < 0) target = displayed.length - 1;
            if (target >= displayed.length) target = 0;
            list.select(target);
            void selectIndex(target);
        },
        top: () => { list.select(0); void selectIndex(0); },
        bottom: () => {
            const last = displayed.length - 1;
            list.select(last);
            void selectIndex(last);
        },
    });


    // ── Search box ────────────────────────────────────────────────────────────

    // Note: blessed.textbox already calls screen.render() on keypress when
    // inputOnFocus is true. An extra render here causes double-paints that
    // leave cursor/letter artifacts on the rest of the UI.

    searchBox.key(['enter'], () => {
        const q = searchBox.getValue().trim();
        if (q) runSearch(q);
        list.focus();
    });

    searchBox.key(['escape'], () => {
        list.focus();
        screen.render();
    });

    // ── Mode switching ────────────────────────────────────────────────────────

    function switchMode(newMode: SearchMode): void {
        mode = newMode;
        setHeader();
        screen.render();
        // Focus search box so user can adjust query or just hit enter
        searchBox.focus();
    }

    // ── Key bindings ──────────────────────────────────────────────────────────

    // Mode
    list.key(['f'], () => switchMode('files'));
    list.key(['d'], () => switchMode('dirs'));
    list.key(['c'], () => switchMode('content'));

    // Open in nvim
    list.key(['enter'], async () => {
        const r = current();
        if (!r || r.type === 'dir') return;
        await runInherit('nvim', [r.absPath], screen);
    });

    // Copy path
    list.key(['y'], () => {
        const r = current();
        if (!r) return;
        const cmd = os.platform() === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
        execCommand(`echo ${JSON.stringify(r.absPath)} | ${cmd}`).catch(() => null);
        flashHeader(`Copied: ${r.absPath}`);
    });

    // Toggle batch selection
    list.key(['space'], () => {
        const r = current();
        if (!r) return;
        r.selected = !r.selected;
        renderListItems();
        list.select(currentIdx);
        setHeader();
        renderStats();
        screen.render();
    });

    // Delete single
    list.key(['x'], async () => {
        const r = current();
        if (!r) return;
        const label = r.type === 'dir' ? 'Delete directory' : 'Delete file';
        const msg = `${r.type === 'dir' ? 'Recursively delete' : 'Delete'} ${r.absPath}?`;
        const ok = await modalConfirm(screen, label, msg);
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
            renderListItems();
            setHeader();
            renderStats();
            const newIdx = Math.min(currentIdx, displayed.length - 1);
            if (newIdx >= 0) { list.select(newIdx); void selectIndex(newIdx); }
            else { showNoResults(); }
            screen.render();
        } catch (e) {
            flashHeader(`Delete failed: ${(e as Error).message}`);
        }
    });

    // Delete all selected (batch)
    list.key(['X', 'S-x'], async () => {
        const targets = allResults.filter((r) => r.selected);
        if (targets.length === 0) {
            flashHeader('No items selected — use space to select');

            return;
        }
        const ok = await modalConfirm(screen, 'Batch delete', `Delete ${targets.length} selected item(s)?`);
        if (!ok) return;
        const errors: string[] = [];
        for (const r of targets) {
            try {
                const cmd = r.type === 'dir'
                    ? `rm -rf ${JSON.stringify(r.absPath)}`
                    : `rm -f ${JSON.stringify(r.absPath)}`;
                await execCommand(cmd);
                previewCache.delete(r.absPath);
                metaCache.delete(r.absPath);
            } catch (e) {
                errors.push((e as Error).message);
            }
        }
        const deleted = targets.length - errors.length;
        allResults = allResults.filter((r) => !r.selected || errors.some((err) => r.absPath.includes(err)));
        displayed = displayed.filter((r) => !r.selected || errors.some((err) => r.absPath.includes(err)));
        // clear selection on survivors
        allResults.forEach((r) => { r.selected = false; });
        renderListItems();
        setHeader();
        renderStats();
        const newIdx = Math.min(currentIdx, displayed.length - 1);
        if (newIdx >= 0) { list.select(newIdx); void selectIndex(newIdx); }
        else { showNoResults(); }
        flashHeader(errors.length > 0 ? `Deleted ${deleted}, ${errors.length} error(s)` : `Deleted ${deleted} item(s)`);
        screen.render();
    });

    // Re-run search
    list.key(['r'], () => {
        if (lastQuery) runSearch(lastQuery);
    });

    // Focus search to change query
    list.key(['s', '/'], () => {
        searchBox.focus();
        screen.render();
    });

    // ── Focus ring ────────────────────────────────────────────────────────────

    attachFocusCycleKeys(screen, ring);

    screen.on('resize', () => { renderListItems(); screen.render(); });

    list.focus();
    ring.renderFooter();
    screen.render();

    await awaitScreenDestroy(screen);
}
