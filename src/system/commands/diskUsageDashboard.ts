import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    type ListDetailDashboardApi,
    createListDetailDashboard,
    modalConfirm,
    modalText,
    highlightCode,
    sanitizeForBlessed,
    theme,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';

interface Entry {
    absPath: string;
    name: string;
    isDir: boolean;
    isSymlink: boolean;
    mtimeMs: number;
    mode: number;
    sizeBytes: number | null;
    itemCount: number | null;
    sizeError?: string;
}

interface Row {
    id: string;
    depth: number;
    expandable: boolean;
    isOpen: boolean;
    entry: Entry;
    parentTotal: number | null;
}

const SIZE_CONCURRENCY = 6;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }

    return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatPct(part: number, whole: number): string {
    if (!whole || whole <= 0) return '   - ';
    const pct = (part / whole) * 100;
    if (pct >= 99.95) return '100.0%';

    return `${pct.toFixed(1).padStart(5)}%`;
}

function formatMtime(ms: number): string {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatMode(mode: number): string {
    const perm = (mode & 0o777).toString(8).padStart(3, '0');
    const types = [
        [0o400, 'r'], [0o200, 'w'], [0o100, 'x'],
        [0o040, 'r'], [0o020, 'w'], [0o010, 'x'],
        [0o004, 'r'], [0o002, 'w'], [0o001, 'x'],
    ] as const;
    const sym = types.map(([bit, ch]) => (mode & bit) ? ch : '-').join('');

    return `${perm} (${sym})`;
}

function truncate(s: string, len: number): string {
    if (len <= 1) return s.slice(0, len);

    return s.length > len ? s.slice(0, len - 1) + '…' : s;
}


function escapeTag(s: string): string {
    return s.replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

function copyToClipboard(text: string): void {
    let cmd = '';
    let args: string[] = [];
    if (process.platform === 'darwin') {
        cmd = 'pbcopy';
    } else if (process.env.WAYLAND_DISPLAY) {
        cmd = 'wl-copy';
    } else if (process.env.DISPLAY) {
        cmd = 'xclip';
        args = ['-selection', 'clipboard'];
    } else { return; }
    try {
        const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(text);
    } catch { /* no-op */ }
}

async function listChildren(dir: string): Promise<Entry[]> {
    let dirents;
    try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: Entry[] = [];
    await Promise.all(dirents.map(async (de) => {
        const abs = path.join(dir, de.name);
        try {
            const st = await fs.lstat(abs);
            const isSymlink = st.isSymbolicLink();
            const isDir = !isSymlink && st.isDirectory();
            out.push({
                absPath: abs,
                name: de.name,
                isDir,
                isSymlink,
                mtimeMs: st.mtimeMs,
                mode: st.mode,
                sizeBytes: isDir ? null : st.size,
                itemCount: isDir ? null : 1,
            });
        } catch { /* skip */ }
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));

    return out;
}

interface SizeResult { bytes: number; items: number; error?: string }

async function computeDirSize(
    dir: string,
    isCancelled: () => boolean,
): Promise<SizeResult> {
    let totalBytes = 0;
    let totalItems = 0;
    let firstError: string | undefined;
    const queue: string[] = [dir];
    let active = 0;
    let resolveDone: () => void = () => { /* replaced below */ };
    const done = new Promise<void>((res) => { resolveDone = res; });

    function pump(): void {
        if (isCancelled()) { resolveDone();

 return; }
        while (active < SIZE_CONCURRENCY && queue.length > 0) {
            const next = queue.shift() as string;
            active++;
            void (async (): Promise<void> => {
                try {
                    const dirents = await fs.readdir(next, { withFileTypes: true });
                    for (const de of dirents) {
                        if (isCancelled()) break;
                        const abs = path.join(next, de.name);
                        try {
                            const st = await fs.lstat(abs);
                            totalItems++;
                            if (st.isDirectory()) {
                                queue.push(abs);
                            } else {
                                totalBytes += st.size;
                            }
                        } catch (e) {
                            if (!firstError) firstError = (e as Error).message;
                        }
                    }
                } catch (e) {
                    if (!firstError) firstError = (e as Error).message;
                }
                active--;
                if (active === 0 && queue.length === 0) resolveDone();
                else pump();
            })();
        }
        if (active === 0 && queue.length === 0) resolveDone();
    }

    pump();
    await done;

    return firstError !== undefined
        ? { bytes: totalBytes, items: totalItems, error: firstError }
        : { bytes: totalBytes, items: totalItems };
}

type SortMode = 'size-desc' | 'size-asc' | 'name' | 'mtime' | 'count';

function sortEntries(entries: Entry[], mode: SortMode): Entry[] {
    const arr = entries.slice();
    arr.sort((a, b) => {
        switch (mode) {
            case 'size-desc':
                return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1);
            case 'size-asc':
                return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
            case 'name':
                return a.name.localeCompare(b.name);
            case 'mtime':
                return b.mtimeMs - a.mtimeMs;
            case 'count':
                return (b.itemCount ?? -1) - (a.itemCount ?? -1);
        }
    });

    return arr;
}

export async function openDiskUsageDashboard(): Promise<void> {
    const initialRoot = process.cwd();

    let scanVersion = 0;
    const cache = new Map<string, Entry[]>();

    let root: string = initialRoot;
    let rootSize: number | null = null;
    let rows: Row[] = [];
    const expanded = new Set<string>();
    const selected = new Set<string>();
    let sortMode: SortMode = 'size-desc';
    let scanInFlight = 0;
    let api: ListDetailDashboardApi<Row> | null = null;
    let rebuildTimer: NodeJS.Timeout | null = null;

    function sortLabel(): string {
        return ({
            'size-desc': 'size\u2193',
            'size-asc': 'size\u2191',
            'name': 'name',
            'mtime': 'modified',
            'count': 'items',
        } as const)[sortMode];
    }

    function headerContent(): string {
        const sizeText = rootSize === null
            ? theme.dim('scanning\u2026')
            : theme.size(formatBytes(rootSize));
        const selCount = selected.size > 0
            ? `   ${theme.label('selected:')} ${theme.count(selected.size)}`
            : '';
        return ` ${theme.title('\u25c6 disk-usage')}   ` +
            `${theme.label('root:')} ${theme.path(escapeTag(truncate(root, 80)))}   ` +
            `${sizeText}   ${theme.label('sort:')} ${theme.value(sortLabel())}` +
            `${selCount}`;
    }

    function buildRowsForDir(
        dir: string,
        depth: number,
        parentTotal: number | null,
    ): Row[] {
        const entries = cache.get(dir) ?? [];
        const sorted = sortEntries(entries, sortMode);
        const result: Row[] = [];
        for (const e of sorted) {
            const id = e.absPath;
            const open = expanded.has(id);
            const row: Row = {
                id,
                depth,
                expandable: e.isDir,
                isOpen: open,
                entry: e,
                parentTotal,
            };
            result.push(row);
            if (open && e.isDir) {
                const childTotal = e.sizeBytes;
                result.push(...buildRowsForDir(e.absPath, depth + 1, childTotal));
            }
        }
        return result;
    }

    function rebuildAndPush(preserveId?: string): void {
        rows = buildRowsForDir(root, 0, rootSize);
        if (api) {
            api.setRows(rows, { preserveKey: preserveId ?? null });
            api.refreshHeader();
        }
    }

    function scheduleRebuild(): void {
        if (rebuildTimer) return;
        rebuildTimer = setTimeout(() => {
            rebuildTimer = null;
rebuildAndPush(api?.selectedRow()?.id);
        }, 150);
    }

    function recomputeRootSize(): void {
        const top = cache.get(root);
        if (!top) return;
        if (top.some((e) => e.isDir && e.sizeBytes === null)) return;
        rootSize = top.reduce((a, e) => a + (e.sizeBytes ?? 0), 0);
        api?.refreshHeader();
    }

    function scanSizesFor(dir: string, entries: Entry[]): void {
        const myVersion = scanVersion;
        for (const e of entries) {
            if (!e.isDir || e.sizeBytes !== null) continue;
            scanInFlight++;
            void (async (): Promise<void> => {
                const result = await computeDirSize(e.absPath, () => myVersion !== scanVersion);
                if (myVersion !== scanVersion) { scanInFlight--; return; }
                e.sizeBytes = result.bytes;
                e.itemCount = result.items;
                if (result.error) e.sizeError = result.error;
                scanInFlight--;
                if (rows.some((r) => r.entry === e)) {
                    scheduleRebuild();
                }
                if (dir === root) {
                    recomputeRootSize();
                }
            })();
        }
    }

    async function loadDir(dir: string): Promise<Entry[]> {
        const cached = cache.get(dir);
        if (cached) return cached;
        const fresh = await listChildren(dir);
        cache.set(dir, fresh);
        scanSizesFor(dir, fresh);
        return fresh;
    }

    function formatRow(r: Row): string {
        const indent = '  '.repeat(r.depth);
        const expandMarker = r.expandable
            ? (r.isOpen ? `${theme.key('\u25be')} ` : `${theme.key('\u25b8')} `)
            : '  ';
        const select = selected.has(r.id) ? `${theme.accent('\u2713')} ` : '  ';
        const sizeStr = r.entry.sizeBytes === null
            ? theme.dim('     \u2026')
            : theme.size(formatBytes(r.entry.sizeBytes).padStart(10));
        const pctStr = r.parentTotal !== null && r.entry.sizeBytes !== null
            ? theme.dim(formatPct(r.entry.sizeBytes, r.parentTotal))
            : theme.dim('     -');
        const icon = r.entry.isSymlink ? '\ud83d\udd17' : (r.entry.isDir ? '\ud83d\udcc1' : '\ud83d\udcc4');
        const rawName = escapeTag(r.entry.name) + (r.entry.isDir ? '/' : '');
        const name = r.entry.isDir ? theme.dir(rawName) : theme.value(rawName);
        return `${select}${sizeStr} ${pctStr}  ${indent}${expandMarker}${icon} ${name}`;
    }

    function paintDetailsContent(r: Row): string {
        const e = r.entry;
        const sizeText = e.sizeBytes === null ? 'scanning\u2026' : formatBytes(e.sizeBytes);
        const pctText = r.parentTotal !== null && e.sizeBytes !== null
            ? formatPct(e.sizeBytes, r.parentTotal).trim()
            : '-';
        const itemsText = e.itemCount === null ? '\u2026' : `${e.itemCount}`;
        const typeText = e.isSymlink ? 'symlink' : (e.isDir ? 'directory' : 'file');
        const errLine = e.sizeError
            ? `\n ${theme.err('scan error:')} ${escapeTag(e.sizeError)}`
            : '';
        return ` ${theme.label('path:')}    ${theme.path(escapeTag(e.absPath))}\n` +
            ` ${theme.label('type:')}    ${theme.value(typeText)}\n` +
            ` ${theme.label('size:')}    ${theme.size(sizeText)}   ${theme.dim(`(${pctText} of parent)`)}\n` +
            ` ${theme.label('items:')}   ${theme.count(itemsText)}\n` +
            ` ${theme.label('mode:')}    ${theme.value(formatMode(e.mode))}\n` +
            ` ${theme.label('mtime:')}   ${theme.date(formatMtime(e.mtimeMs))}` +
            errLine;
    }

    async function paintChildrenContent(e: Entry): Promise<string> {
        if (!e.isDir) return paintFilePreviewContent(e);
        let entries = cache.get(e.absPath);
        if (!entries) {
            entries = await listChildren(e.absPath);
            cache.set(e.absPath, entries);
            scanSizesFor(e.absPath, entries);
        }
        const sorted = sortEntries(entries, 'size-desc').slice(0, 50);
        // Use ASCII-safe glyphs in the children panel (it's a scrollable text
        // panel; emojis here desync blessed's cell-width tracking under
        // fullUnicode and duplicate glyphs on scroll).
        const lines = sorted.map((c) => {
            const sz = c.sizeBytes === null
                ? theme.dim('     \u2026')
                : theme.size(formatBytes(c.sizeBytes).padStart(10));
            const rawName = escapeTag(sanitizeForBlessed(c.name)) + (c.isDir ? '/' : '');
            const icon = c.isSymlink
                ? theme.link('L')
                : (c.isDir ? theme.dir('D') : theme.file('F'));
            const name = c.isSymlink ? theme.link(rawName) : (c.isDir ? theme.dir(rawName) : theme.value(rawName));
            return ` ${sz}  ${icon} ${name}`;
        });
        const more = entries.length > sorted.length
            ? `\n ${theme.dim(`\u2026and ${entries.length - sorted.length} more`)}`
            : '';
        return ` ${theme.dim('children of')} ${theme.dir(escapeTag(sanitizeForBlessed(e.name)) + '/')}  ${theme.dim(`(${entries.length})`)}\n\n` +
            (lines.join('\n') || ` ${theme.dim('empty')}`) +
            more;
    }

    async function paintFilePreviewContent(e: Entry): Promise<string> {
        const cap = 4096;
        if (e.sizeBytes !== null && e.sizeBytes > 200 * 1024) {
            return ` ${theme.dim(`file too large to preview (${formatBytes(e.sizeBytes)})`)}`;
        }
        try {
            const fh = await fs.open(e.absPath, 'r');
            try {
                const buf = Buffer.alloc(cap);
                const { bytesRead } = await fh.read(buf, 0, cap, 0);
                let text = buf.subarray(0, bytesRead).toString('utf8');
                if (/\u0000/.test(text)) return ` ${theme.dim('binary file (no preview)')}`;
                text = sanitizeForBlessed(text);
                if (bytesRead === cap) text += '\n\u2026';
                return escapeTag(highlightCode(text, e.absPath));
            } finally {
                await fh.close();
            }
        } catch (err) {
            return ` ${theme.err('preview error:')} ${escapeTag((err as Error).message)}`;
        }
    }

    function paintTopStatsContent(): string {
        const top = cache.get(root) ?? [];
        const ranked = sortEntries(top, 'size-desc').slice(0, 10);
        const lines = ranked.map((e, i) => {
            const sz = e.sizeBytes === null
                ? theme.dim('     \u2026')
                : theme.size(formatBytes(e.sizeBytes).padStart(10));
            const rawName = escapeTag(sanitizeForBlessed(e.name));
            const icon = e.isSymlink
                ? theme.link('L')
                : (e.isDir ? theme.dir('D') : theme.file('F'));
            const name = e.isSymlink ? theme.link(rawName) : (e.isDir ? theme.dir(rawName) : theme.value(rawName));
            return ` ${theme.dim((`${i + 1}`).padStart(2) + '.')} ${sz}  ${icon} ${name}`;
        });
        const flightLine = scanInFlight > 0
            ? `\n ${theme.dim(`scanning ${scanInFlight} dirs\u2026`)}`
            : '';
        return ` ${theme.section('top 10 in current root')}\n\n` +
            (lines.join('\n') || ` ${theme.dim('empty')}`) +
            flightLine;
    }

    async function setRoot(newRoot: string): Promise<void> {
        scanVersion++;
        scanInFlight = 0;
        root = path.resolve(newRoot);
        rootSize = null;
        expanded.clear();
        selected.clear();
        cache.clear();
        await loadDir(root);
        rebuildAndPush();
    }

    async function descend(a: ListDetailDashboardApi<Row>): Promise<void> {
        const r = a.selectedRow();
        if (!r?.entry.isDir) return;
        await setRoot(r.entry.absPath);
    }

    async function ascend(): Promise<void> {
        const parent = path.dirname(root);
        if (parent === root) return;
        await setRoot(parent);
    }

    async function refresh(a: ListDetailDashboardApi<Row>): Promise<void> {
        const id = a.selectedRow()?.id;
        scanVersion++;
        scanInFlight = 0;
        cache.clear();
        rootSize = null;
        await loadDir(root);
        rebuildAndPush(id);
    }

    async function deleteSelection(a: ListDetailDashboardApi<Row>): Promise<void> {
        const cur = a.selectedRow();
        const targets: Row[] = selected.size > 0
            ? rows.filter((r) => selected.has(r.id))
            : (cur ? [cur] : []);
        if (targets.length === 0) return;
        const totalBytes = targets.reduce((acc, r) => acc + (r.entry.sizeBytes ?? 0), 0);
        const preview = targets.slice(0, 6).map((r) => `  ${r.entry.absPath}`).join('\n')
            + (targets.length > 6 ? `\n  \u2026and ${targets.length - 6} more` : '');
        const ok = await modalConfirm(
            a.screen,
            'delete',
            `Permanently delete ${targets.length} item(s) (${formatBytes(totalBytes)})?\n\n${preview}\n\nThis cannot be undone.`,
        );
        if (!ok) return;
        let okCount = 0;
        const failed: string[] = [];
        for (const r of targets) {
            try {
                await fs.rm(r.entry.absPath, { recursive: true, force: true });
                okCount++;
                selected.delete(r.id);
                expanded.delete(r.id);
            } catch (err) {
                failed.push(`${r.entry.name}: ${(err as Error).message}`);
            }
        }
        cache.delete(root);
        for (const r of targets) cache.delete(path.dirname(r.entry.absPath));
        scanVersion++;
        scanInFlight = 0;
        rootSize = null;
        await loadDir(root);
        rebuildAndPush();
        if (failed.length > 0) {
            a.flashHeader(` ${theme.err(`deleted ${okCount}, failed ${failed.length}: ${escapeTag(failed[0])}`)}`);
        } else {
            a.flashHeader(` ${theme.success(`\u2713 deleted ${okCount} item(s) (${formatBytes(totalBytes)})`)}`);
        }
    }

    async function openSelected(a: ListDetailDashboardApi<Row>): Promise<void> {
        const r = a.selectedRow();
        if (r === undefined) return;
        const target = r.entry.absPath;
        if (r.entry.isDir) {
            const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
            spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
            a.flashHeader(` ${theme.success('\u2713 opened')} ${theme.path(escapeTag(target))}`);
        } else {
            await runInherit('nvim', [target], a.screen);
        }
    }

    async function changeRootPrompt(a: ListDetailDashboardApi<Row>): Promise<void> {
        const result = await modalText(a.screen, 'set root', root);
        if (result.value === null) return;
        const trimmed = result.value.trim();
        if (!trimmed) return;
        const expandedPath = trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
        try {
            const st = await fs.stat(expandedPath);
            if (!st.isDirectory()) {
                a.flashHeader(` ${theme.err('not a directory')}`);
                return;
            }
            await setRoot(expandedPath);
        } catch (err) {
            a.flashHeader(` ${theme.err(escapeTag((err as Error).message))}`);
        }
    }

    await loadDir(root);
    rows = buildRowsForDir(root, 0, rootSize);

    await createListDetailDashboard<Row>({
        title: 'disk-usage',
        headerContent,
        listLabel: 'entries',
        listFocusName: 'entries',
        listWidth: '50%',
        listTags: true,
        keymapText:
            `${theme.key('j/k')} nav  ${theme.key('enter')} descend  ` +
            `${theme.key('-')} up  ${theme.key('e/l')} expand  ` +
            `${theme.key('space')} select  ${theme.key('X')} delete  ` +
            `${theme.key('o')} open  ${theme.key('s')} sort  ` +
            `${theme.key('/')} filter  ${theme.key('r')} refresh  ` +
            `${theme.key('R')} new root  ${theme.key('H')} home  ` +
            `${theme.key('y')} yank  ${theme.key('Tab')} focus  ${theme.key('q')} quit`,
        initialRows: rows,
        rowKey: (r) => r.id,
        renderListItem: (r) => formatRow(r),
        filter: {
            label: 'filter',
            mode: 'live',
            match: (r, q) => r.entry.name.toLowerCase().includes(q.toLowerCase()),
        },
        tree: {
            expanded,
            rebuild: (preserveId) => rebuildAndPush(preserveId),
        },
        detailPanels: [
            {
                label: 'details',
                focusName: 'details',
                paint: (r) => paintDetailsContent(r),
            },
            {
                label: 'children',
                focusName: 'children',
                paint: (r) => paintChildrenContent(r.entry),
            },
            {
                label: 'top 10',
                focusName: 'stats',
                paint: () => paintTopStatsContent(),
            },
        ],
        actions: [
            { keys: 'enter', handler: (_r, a) => descend(a) },
            { keys: ['-', 'backspace'], handler: () => ascend() },
            {
                keys: 'e',
                handler: (r) => {
                    if (!r?.expandable) return;
                    if (expanded.has(r.id)) expanded.delete(r.id);
                    else expanded.add(r.id);
                    rebuildAndPush(r.id);
                },
            },
            {
                keys: 'space',
                handler: (r, a) => {
                    if (r === undefined) return;
                    if (selected.has(r.id)) selected.delete(r.id);
                    else selected.add(r.id);
                    a.repaint();
                    a.refreshHeader();
                },
            },
            { keys: ['X', 'S-x'], handler: (_r, a) => deleteSelection(a) },
            { keys: 'o', handler: (_r, a) => openSelected(a) },
            { keys: 'r', handler: (_r, a) => refresh(a) },
            { keys: ['R', 'S-r'], handler: (_r, a) => changeRootPrompt(a) },
            { keys: ['H', 'S-h'], handler: () => setRoot(os.homedir()) },
            {
                keys: 's',
                handler: (_r, a) => {
                    const order: SortMode[] = ['size-desc', 'size-asc', 'name', 'mtime', 'count'];
                    sortMode = order[(order.indexOf(sortMode) + 1) % order.length];
                    rebuildAndPush(a.selectedRow()?.id);
                },
            },
            {
                keys: 'y',
                handler: (r, a) => {
                    if (r === undefined) return;
                    copyToClipboard(r.entry.absPath);
                    a.flashHeader(` ${theme.success('\u2713 copied')} ${theme.path(escapeTag(r.entry.absPath))}`);
                },
            },
        ],
        onReady: (a) => { api = a; },
    });
}

