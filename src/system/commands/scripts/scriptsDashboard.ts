import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { systemScriptsPath } from '@/filePaths';
import { execCommand } from '@/utils/bashHelper';
import { filterGitKeep } from '@/utils/common';
import {
    attachFocusCycleKeys,
    attachVerticalNavigation,
    awaitScreenDestroy,
    createDashboardScreen,
    createDashboardShell,
    escTag,
    modalConfirm,
    modalText,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';
import { makeExecutableIfNoPermissions } from '@/system/utils/fileUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScriptEntry {
    name: string;
    absPath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadScripts(): Promise<ScriptEntry[]> {
    try {
        const names = filterGitKeep(await fs.readdir(systemScriptsPath));
        return names.map((name) => ({ name, absPath: path.join(systemScriptsPath, name) }));
    } catch {
        return [];
    }
}

async function loadPreview(absPath: string): Promise<string> {
    try {
        const { stdout } = await execCommand(`head -n 100 ${JSON.stringify(absPath)} 2>/dev/null`);
        if (!stdout.trim()) return '{gray-fg}(empty script){/gray-fg}';
        return escTag(stdout);
    } catch {
        return '{red-fg}(could not read script){/red-fg}';
    }
}

async function loadMeta(entry: ScriptEntry): Promise<string> {
    try {
        const [lsOut, wcOut] = await Promise.all([
            execCommand(`ls -la ${JSON.stringify(entry.absPath)} 2>/dev/null`).then((r) => r.stdout.trim()),
            execCommand(`wc -l ${JSON.stringify(entry.absPath)} 2>/dev/null`).then((r) => r.stdout.trim()),
        ]);
        const lineCount = wcOut.split(/\s+/)[0] ?? '?';
        const modified = lsOut.split(/\s+/).slice(5, 8).join(' ') || '?';
        const size = lsOut.split(/\s+/)[4] ?? '?';
        return (
            `{cyan-fg}name    {/cyan-fg}${escTag(entry.name)}\n` +
            `{cyan-fg}path    {/cyan-fg}${escTag(entry.absPath)}\n` +
            `{cyan-fg}size    {/cyan-fg}${size} bytes\n` +
            `{cyan-fg}lines   {/cyan-fg}${lineCount}\n` +
            `{cyan-fg}modified{/cyan-fg}${modified}\n\n` +
            `{white-fg}${escTag(lsOut)}{/white-fg}`
        );
    } catch {
        return `{cyan-fg}name{/cyan-fg}  ${escTag(entry.name)}`;
    }
}

function renderRow(entry: ScriptEntry, isSelected: boolean): string {
    const marker = isSelected ? '{yellow-fg}▶{/yellow-fg} ' : '  ';
    return `${marker}{green-fg}📜{/green-fg} ${escTag(entry.name)}`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function openScriptsDashboard(): Promise<void> {
    let scripts: ScriptEntry[] = await loadScripts();
    let displayed: ScriptEntry[] = scripts.slice();
    let filterQuery = '';
    let currentIdx = -1;
    let loadSeq = 0;
    const previewCache = new Map<string, string>();
    const metaCache = new Map<string, string>();

    const screen = createDashboardScreen({ title: 'kra-scripts' });

    const shell = createDashboardShell({
        screen,
        headerContent: '',
        listLabel: 'scripts',
        listFocusName: 'scripts',
        listWidth: '42%',
        listItems: [],
        listTags: true,
        search: {
            label: 'filter',
            width: '42%',
            inputOnFocus: true,
            keys: false,
        },
        detailPanels: [
            { label: 'preview', focusName: 'preview' },
            { label: 'info', focusName: 'info' },
            { label: 'output', focusName: 'output', content: '{gray-fg}(no run yet — press x to capture output){/gray-fg}' },
        ],
        keymapText: () =>
            `{cyan-fg}j/k{/cyan-fg} nav   ` +
            `{cyan-fg}enter{/cyan-fg} run+capture   ` +
            `{cyan-fg}x{/cyan-fg} run terminal   ` +
            `{cyan-fg}e{/cyan-fg} edit   ` +
            `{cyan-fg}n{/cyan-fg} new   ` +
            `{cyan-fg}D{/cyan-fg} delete   ` +
            `{cyan-fg}y{/cyan-fg} yank path   ` +
            `{cyan-fg}r{/cyan-fg} refresh   ` +
            `{cyan-fg}s{/cyan-fg}/{cyan-fg}/{/cyan-fg} filter   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
    });

    const { header, list, ring } = shell;
    const searchBox = shell.searchBox!;
    const [previewPanel, infoPanel, outputPanel] = shell.detailPanels;

    // ── Header ────────────────────────────────────────────────────────────────

    function setHeader(): void {
        const countTag = `{cyan-fg}scripts{/cyan-fg} {yellow-fg}${scripts.length}{/yellow-fg}`;
        const filterTag = filterQuery ? `  {cyan-fg}filter{/cyan-fg} {white-fg}${escTag(filterQuery)}{/white-fg}` : '';
        header.setContent(
            ` {magenta-fg}{bold}◆ scripts{/bold}{/magenta-fg}   ${countTag}${filterTag}`,
        );
    }
    setHeader();

    function flashHeader(msg: string): void {
        const prev = header.content as string;
        header.setContent(prev + `  {green-fg}${escTag(msg)}{/green-fg}`);
        screen.render();
        setTimeout(() => { header.setContent(prev); screen.render(); }, 1800).unref();
    }

    // ── List rendering ────────────────────────────────────────────────────────

    function renderListItems(): void {
        list.clearItems();
        list.setItems(displayed.map((e, i) => renderRow(e, i === currentIdx)));
    }
    renderListItems();

    // ── Script selection ──────────────────────────────────────────────────────

    async function selectIndex(i: number): Promise<void> {
        if (i < 0 || i >= displayed.length) return;
        currentIdx = i;
        const entry = displayed[i];
        const seq = ++loadSeq;

        const cachedPreview = previewCache.get(entry.absPath);
        const cachedMeta = metaCache.get(entry.absPath);

        if (cachedPreview !== undefined) {
            previewPanel.setContent(cachedPreview);
        } else {
            previewPanel.setContent('{gray-fg}Loading…{/gray-fg}');
        }
        if (cachedMeta !== undefined) {
            infoPanel.setContent(cachedMeta);
        } else {
            infoPanel.setContent('{gray-fg}Loading…{/gray-fg}');
        }
        screen.render();

        if (cachedPreview === undefined || cachedMeta === undefined) {
            const [preview, meta] = await Promise.all([
                cachedPreview === undefined ? loadPreview(entry.absPath) : Promise.resolve(cachedPreview),
                cachedMeta === undefined ? loadMeta(entry) : Promise.resolve(cachedMeta),
            ]);
            if (seq !== loadSeq) return;
            previewCache.set(entry.absPath, preview);
            metaCache.set(entry.absPath, meta);
            previewPanel.setContent(preview);
            infoPanel.setContent(meta);
            screen.render();
        }
    }

    function current(): ScriptEntry | undefined {
        return currentIdx >= 0 && currentIdx < displayed.length ? displayed[currentIdx] : undefined;
    }

    list.on('select item', (_item: unknown, idx: number) => {
        void selectIndex(idx);
    });

    // ── Filter / search ───────────────────────────────────────────────────────

    function applyFilter(): void {
        const q = filterQuery.trim().toLowerCase();
        displayed = q ? scripts.filter((e) => e.name.toLowerCase().includes(q)) : scripts.slice();
        renderListItems();
        setHeader();
        if (displayed.length > 0) {
            currentIdx = -1;
            list.select(0);
            void selectIndex(0);
        } else {
            currentIdx = -1;
            previewPanel.setContent('{gray-fg}no matches{/gray-fg}');
            infoPanel.setContent('');
            // output panel intentionally preserved (shows last run)
        }
        screen.render();
    }

    searchBox.on('keypress', () => {
        setImmediate(() => {
            const v = searchBox.getValue();
            if (v !== filterQuery) {
                filterQuery = v;
                applyFilter();
            }
        });
    });
    searchBox.key(['enter'], () => { list.focus(); });
    searchBox.key(['escape'], () => {
        searchBox.clearValue();
        if (filterQuery) { filterQuery = ''; applyFilter(); }
        list.focus();
    });

    // ── Reload helper ─────────────────────────────────────────────────────────

    async function reload(): Promise<void> {
        previewCache.clear();
        metaCache.clear();
        scripts = await loadScripts();
        applyFilter();
        setHeader();
        screen.render();
    }

    // ── Key bindings ──────────────────────────────────────────────────────────

    // Run selected script and capture output into the output panel
    list.key(['enter'], async () => {
        const entry = current();
        if (!entry) return;
        await makeExecutableIfNoPermissions(entry.absPath);
        outputPanel.setContent(`{gray-fg}Running {/gray-fg}{yellow-fg}${escTag(entry.name)}{/yellow-fg}{gray-fg}…{/gray-fg}`);
        outputPanel.focus();
        screen.render();
        try {
            const { stdout, stderr } = await execCommand(`sh ${JSON.stringify(entry.absPath)} 2>&1`);
            const combined = (stdout + stderr).trim();
            outputPanel.setContent(
                `{cyan-fg}▶ ${escTag(entry.name)}{/cyan-fg}\n\n` +
                (combined ? escTag(combined) : '{gray-fg}(no output){/gray-fg}'),
            );
            (outputPanel as any).setScrollPerc(100);
        } catch (err) {
            outputPanel.setContent(
                `{red-fg}Error running ${escTag(entry.name)}:{/red-fg}\n\n` +
                escTag((err as Error).message),
            );
        }
        screen.render();
    });

    // Run selected script interactively in the terminal (stdio inherited)
    list.key(['x'], async () => {
        const entry = current();
        if (!entry) return;
        await makeExecutableIfNoPermissions(entry.absPath);
        outputPanel.setContent('{gray-fg}(interactive run — output not captured){/gray-fg}');
        await runInherit('sh', [entry.absPath], screen);
        screen.render();
    });

    // Edit in nvim
    list.key(['e'], async () => {
        const entry = current();
        if (!entry) return;
        await runInherit('nvim', [entry.absPath], screen);
        previewCache.delete(entry.absPath);
        metaCache.delete(entry.absPath);
        await selectIndex(currentIdx);
        screen.render();
    });

    // New script
    list.key(['n'], async () => {
        const { value: rawName } = await modalText(screen, 'New script name (e.g. deploy.sh)', '', {
            hint: 'enter create · esc cancel',
        });
        const name = rawName?.trim();
        if (!name) return;
        const safeName = name.endsWith('.sh') ? name : `${name}.sh`;
        const newPath = path.join(systemScriptsPath, safeName);
        // Write shebang so the file is immediately executable
        try {
            await fs.writeFile(newPath, '#!/bin/bash\n\n', { flag: 'wx' });
            await execCommand(`chmod +x ${JSON.stringify(newPath)}`);
        } catch {
            // File may already exist — just open it
        }
        await runInherit('nvim', [newPath], screen);
        await reload();
        const idx = displayed.findIndex((e) => e.name === safeName);
        if (idx >= 0) { list.select(idx); void selectIndex(idx); }
        screen.render();
    });

    // Delete
    list.key(['D', 'S-d'], async () => {
        const entry = current();
        if (!entry) return;
        const ok = await modalConfirm(screen, 'Delete script', `Delete ${entry.name}?`);
        if (!ok) return;
        try {
            await fs.unlink(entry.absPath);
            previewCache.delete(entry.absPath);
            metaCache.delete(entry.absPath);
            scripts = scripts.filter((e) => e.absPath !== entry.absPath);
            displayed = displayed.filter((e) => e.absPath !== entry.absPath);
            renderListItems();
            setHeader();
            const newIdx = Math.min(currentIdx, displayed.length - 1);
            if (newIdx >= 0) { list.select(newIdx); void selectIndex(newIdx); }
            else { currentIdx = -1; previewPanel.setContent(''); infoPanel.setContent(''); }
            screen.render();
        } catch (e) {
            flashHeader(`Error: ${(e as Error).message}`);
        }
    });

    // Yank path
    list.key(['y'], () => {
        const entry = current();
        if (!entry) return;
        const cmd = os.platform() === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
        execCommand(`echo ${JSON.stringify(entry.absPath)} | ${cmd}`).catch(() => null);
        flashHeader(`Copied: ${entry.name}`);
    });

    // Refresh
    list.key(['r'], () => { void reload(); });

    // Focus search
    list.key(['s', '/'], () => {
        searchBox.focus();
        screen.render();
    });

    // ── Navigation ────────────────────────────────────────────────────────────

    attachVerticalNavigation(list, {
        moveBy: (delta) => {
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
            if (last >= 0) { list.select(last); void selectIndex(last); }
        },
    });

    // ── Focus ring ────────────────────────────────────────────────────────────

    attachFocusCycleKeys(screen, ring);

    screen.on('resize', () => { renderListItems(); screen.render(); });

    list.focus();
    ring.renderFooter();
    screen.render();

    if (displayed.length > 0) {
        list.select(0);
        void selectIndex(0);
    }

    await awaitScreenDestroy(screen);
}
