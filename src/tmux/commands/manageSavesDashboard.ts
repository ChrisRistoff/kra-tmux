import * as blessed from 'blessed';
import * as fs from 'fs/promises';
import { serverFilesFolder, singleSessionFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import {
    getSavedFileByPath,
    getDateString,
} from '@/tmux/utils/sessionUtils';
import { listSavedNames } from '@/tmux/utils/savedSessionsIO';
import {
    escTag,
    modalText,
    modalConfirm,
    createDashboardShell,
    attachVerticalNavigation,
    createListDetailDashboard,
    theme,
} from '@/UI/dashboard';

interface FileEntry {
    name: string;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    sessions?: TmuxSessions;
    parseError?: string;
}

async function loadFileEntries(folder: string): Promise<FileEntry[]> {
    const names = await listSavedNames(folder);
    const entries: FileEntry[] = [];
    for (const name of names) {
        const fp = `${folder}/${name}`;
        try {
            const st = await fs.stat(fp);
            entries.push({ name, path: fp, sizeBytes: st.size, mtimeMs: st.mtimeMs });
        } catch {
            entries.push({ name, path: fp, sizeBytes: 0, mtimeMs: 0 });
        }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return entries;
}

async function ensureSessions(entry: FileEntry): Promise<void> {
    if (entry.sessions || entry.parseError) return;
    try {
        entry.sessions = await getSavedFileByPath(entry.path);
    } catch (e) {
        entry.parseError = e instanceof Error ? e.message : String(e);
    }
}

function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;

    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function fmtAge(mtimeMs: number): string {
    if (!mtimeMs) return '?';
    const diff = Date.now() - mtimeMs;
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);

    return `${d}d`;
}

function summarize(sessions: TmuxSessions): { sessions: number; windows: number; panes: number } {
    let w = 0;
    let p = 0;
    for (const k of Object.keys(sessions)) {
        for (const win of sessions[k].windows) {
            w++;
            p += win.panes.length;
        }
    }

    return { sessions: Object.keys(sessions).length, windows: w, panes: p };
}


function renderSummary(entry: FileEntry | undefined): string {
    if (!entry) return theme.dim('(no save selected)');
    if (entry.parseError) return `${theme.err('parse error:')}\n${escTag(entry.parseError)}`;
    if (!entry.sessions) return theme.dim('(loading...)');
    const s = summarize(entry.sessions);
    const lines: string[] = [];
    lines.push(`{bold}${theme.value(escTag(entry.name))}{/bold}`);
    lines.push('');
    lines.push(`${theme.label('sessions:')} ${theme.count(s.sessions)}   ${theme.label('windows:')} ${theme.count(s.windows)}   ${theme.label('panes:')} ${theme.count(s.panes)}`);
    lines.push(`${theme.label('size:')} ${theme.size(fmtSize(entry.sizeBytes))}   ${theme.label('saved:')} ${theme.date(fmtAge(entry.mtimeMs) + ' ago')}`);
    lines.push('');
    for (const sessName of Object.keys(entry.sessions)) {
        const sess = entry.sessions[sessName];
        const path = sess.windows[0]?.currentPath ?? '';
        let panes = 0;
        for (const w of sess.windows) panes += w.panes.length;
        lines.push(`  ${theme.accent(escTag(sessName))}  ${theme.dim(`w${sess.windows.length} p${panes}`)}  ${theme.path(escTag(path))}`);
    }

    return lines.join('\n');
}

function renderDetails(entry: FileEntry | undefined): string {
    if (!entry?.sessions) return '';
    const lines: string[] = [];
    for (const sessName of Object.keys(entry.sessions)) {
        const sess = entry.sessions[sessName];
        lines.push(`{bold}${theme.accent(escTag(sessName))}{/bold}`);
        for (const [i, w] of sess.windows.entries()) {
            lines.push(`  ${theme.warn(`#${i} ${escTag(w.windowName || '')}`)}  ${theme.dim(escTag(w.currentCommand || ''))}`);
            lines.push(`    ${theme.path(escTag(w.currentPath))}`);
            for (const [j, p] of w.panes.entries()) {
                lines.push(`      ${theme.success(`pane ${j}`)}  ${theme.value(escTag(p.currentCommand || ''))}  ${theme.path(escTag(p.currentPath))}`);
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}

interface BuilderRow {
    level: 'session' | 'window' | 'pane';
    sessionName: string;
    windowIdx?: number;
    paneIdx?: number;
    label: string;
}

function renderTreeRows(sessions: TmuxSessions): BuilderRow[] {
    const rows: BuilderRow[] = [];
    const names = Object.keys(sessions);
    if (names.length === 0) {
        return [{ level: 'session', sessionName: '', label: theme.dim('(empty — press s to add a session)') }];
    }
    for (const sname of names) {
        const sess = sessions[sname];
        rows.push({
            level: 'session',
            sessionName: sname,
            label: `{bold}${theme.accent(`◆ ${escTag(sname)}`)}{/bold}  ${theme.dim(`(${sess.windows.length}w)`)}`,
        });
        for (const [wi, w] of sess.windows.entries()) {
            rows.push({
                level: 'window',
                sessionName: sname,
                windowIdx: wi,
                label: `  ${theme.warn(`▸ #${wi} ${escTag(w.windowName || '(unnamed)')}`)}  ${theme.path(escTag(w.currentPath))}`,
            });
            for (const [pi, p] of w.panes.entries()) {
                rows.push({
                    level: 'pane',
                    sessionName: sname,
                    windowIdx: wi,
                    paneIdx: pi,
                    label: `      ${theme.success(`· pane ${pi}`)}  ${theme.value(escTag(p.currentCommand || '(shell)'))}  ${theme.path(escTag(p.currentPath))}`,
                });
            }
        }
    }

    return rows;
}

function renderNodeDetails(sessions: TmuxSessions, row: BuilderRow | undefined): string {
    if (!row?.sessionName) {
        return `${theme.dim('Press ')}${theme.key('s')}${theme.dim(' to add a new session.')}`;
    }
    const sess = sessions[row.sessionName];
    if (!sess) return '';
    const lines: string[] = [];
    if (row.level === 'session') {
        lines.push(`{bold}Session:{/bold} ${theme.accent(escTag(row.sessionName))}`);
        lines.push(`${theme.label('windows:')} ${theme.count(sess.windows.length)}`);
        lines.push('');
        lines.push(`${theme.key('w')} add window   ${theme.key('e')} rename   ${theme.key('D')} delete session`);
    } else if (row.level === 'window' && row.windowIdx !== undefined) {
        const w = sess.windows[row.windowIdx];
        if (!w) return '';
        lines.push(`{bold}Window:{/bold} ${theme.warn(`#${row.windowIdx} ${escTag(w.windowName || '(unnamed)')}`)}`);
        lines.push(`${theme.label('cwd:')} ${theme.path(escTag(w.currentPath))}`);
        lines.push(`${theme.label('cmd:')} ${theme.value(escTag(w.currentCommand || '(shell)'))}`);
        lines.push(`${theme.label('panes:')} ${theme.count(w.panes.length)}`);
        lines.push('');
        lines.push(`${theme.key('p')} add pane   ${theme.key('e')} edit fields   ${theme.key('D')} delete window`);
    } else if (row.level === 'pane' && row.windowIdx !== undefined && row.paneIdx !== undefined) {
        const p = sess.windows[row.windowIdx]?.panes[row.paneIdx];
        if (!p) return '';
        lines.push(`{bold}Pane:{/bold} ${theme.success(String(row.paneIdx))} of window #${row.windowIdx}`);
        lines.push(`${theme.label('cwd:')} ${theme.path(escTag(p.currentPath))}`);
        lines.push(`${theme.label('cmd:')} ${theme.value(escTag(p.currentCommand || '(shell)'))}`);
        lines.push('');
        lines.push(`${theme.key('e')} edit fields   ${theme.key('D')} delete pane`);
    }

    return lines.join('\n');
}

async function buildNewSaveFlow(parentScreen: blessed.Widgets.Screen): Promise<TmuxSessions | null> {
    return new Promise((resolve) => {
        const sessions: TmuxSessions = {};
        let selectedIdx = 0;

        const overlay = blessed.box({
            parent: parentScreen,
            top: 'center', left: 'center',
            width: '90%', height: '90%',
            border: { type: 'line' },
            style: { border: { fg: 'magenta' }, bg: 'black' },
            tags: true,
            label: ' build new save ',
        });

        const shell = createDashboardShell({
            screen: parentScreen,
            parent: overlay,
            listLabel: 'structure',
            listFocusName: 'structure',
            listWidth: '60%',
            listItems: [],
            listTags: true,
            search: false,
            detailPanels: [
                { label: 'selected', focusName: 'selected', bottom: 3 },
            ],
            keymapText: () =>
                `${theme.key('j/k')} nav   ${theme.key('[ ]')} ±10   ` +
                `${theme.key('s')} +session   ${theme.key('w')} +window   ${theme.key('p')} +pane   ` +
                `${theme.key('e')} edit   ${theme.key('D')} delete   ` +
                `${theme.key('enter')} done   ${theme.key('esc/q')} cancel`,
        });
        const { header } = shell;
        const tree = shell.list;
        const [detail] = shell.detailPanels;

        let rows: BuilderRow[] = [];


        function refresh(): void {
            rows = renderTreeRows(sessions);
            tree.setItems(rows.map((r) => r.label));
            if (selectedIdx >= rows.length) selectedIdx = Math.max(0, rows.length - 1);
            tree.select(selectedIdx);
            const totals = (() => {
                let w = 0; let p = 0;
                for (const k of Object.keys(sessions)) {
                    for (const win of sessions[k].windows) { w++; p += win.panes.length; }
                }

                return { s: Object.keys(sessions).length, w, p };
            })();
            header.setContent(
                `${theme.title('building save')}  ${theme.dim('|')}  ` +
                `${theme.label('sessions:')} ${theme.count(totals.s)}   ${theme.label('windows:')} ${theme.count(totals.w)}   ${theme.label('panes:')} ${theme.count(totals.p)}`,
            );
            detail.setContent(renderNodeDetails(sessions, rows[selectedIdx]));
            parentScreen.render();
        }

        function close(result: TmuxSessions | null): void {
            overlay.destroy();
            parentScreen.render();
            resolve(result);
        }

        tree.on('select item', (_item: blessed.Widgets.BlessedElement, idx: number) => {
            selectedIdx = idx;
            detail.setContent(renderNodeDetails(sessions, rows[selectedIdx]));
            parentScreen.render();
        });

        tree.key(['s'], async () => {
            const name = await modalText(parentScreen, 'New session name', '');
            if (!name.value?.trim()) { tree.focus();

 return; }
            const sname = name.value.trim();
            if (sessions[sname]) {
                await modalConfirm(parentScreen, 'Notice', `Session "${escTag(sname)}" already exists.`);
                tree.focus();

 return;
            }
            sessions[sname] = { windows: [] };
            const newRows = renderTreeRows(sessions);
            const idx = newRows.findIndex((r) => r.level === 'session' && r.sessionName === sname);
            if (idx >= 0) selectedIdx = idx;
            refresh();
            tree.focus();
        });

        tree.key(['w'], async () => {
            const cur = rows[selectedIdx];
            if (!cur.sessionName) { tree.focus();

 return; }
            const sess = sessions[cur.sessionName];
            if (!sess) { tree.focus();

 return; }
            const wname = await modalText(parentScreen, 'Window name', '');
            if (wname.value === null) { tree.focus();

 return; }
            const wpath = await modalText(parentScreen, 'Window cwd', process.env.HOME ?? '/');
            if (!wpath.value?.trim()) { tree.focus();

 return; }
            const wcmd = await modalText(parentScreen, 'Initial command (blank for shell)', '');
            if (wcmd.value === null) { tree.focus();

 return; }
            sess.windows.push({
                windowName: wname.value.trim(),
                currentCommand: wcmd.value.trim(),
                layout: '',
                currentPath: wpath.value.trim(),
                gitRepoLink: undefined,
                panes: [{
                    currentCommand: wcmd.value.trim(),
                    currentPath: wpath.value.trim(),
                    gitRepoLink: undefined,
                    paneLeft: '0',
                    paneTop: '0',
                }],
                windowIndex: sess.windows.length,
            });
            refresh();
            tree.focus();
        });

        tree.key(['p'], async () => {
            const cur = rows[selectedIdx];
            if (!cur.sessionName || cur.windowIdx === undefined) { tree.focus();

 return; }
            const w = sessions[cur.sessionName].windows[cur.windowIdx];
            if (!w) { tree.focus();

 return; }
            const ppath = await modalText(parentScreen, 'Pane cwd', w.currentPath);
            if (!ppath.value?.trim()) { tree.focus();

 return; }
            const pcmd = await modalText(parentScreen, 'Pane command (blank for shell)', '');
            if (pcmd.value === null) { tree.focus();

 return; }
            w.panes.push({
                currentCommand: pcmd.value.trim(),
                currentPath: ppath.value.trim(),
                gitRepoLink: undefined,
                paneLeft: '0',
                paneTop: String(w.panes.length),
            });
            refresh();
            tree.focus();
        });

        tree.key(['e'], async () => {
            const cur = rows[selectedIdx];
            if (!cur.sessionName) { tree.focus();

 return; }
            if (cur.level === 'session') {
                const newName = await modalText(parentScreen, 'Rename session', cur.sessionName);
                if (!newName.value?.trim() || newName.value.trim() === cur.sessionName) { tree.focus();

 return; }
                const trimmed = newName.value.trim();
                if (sessions[trimmed]) {
                    await modalConfirm(parentScreen, 'Notice', `Session "${escTag(trimmed)}" already exists.`);
                    tree.focus();

 return;
                }
                sessions[trimmed] = sessions[cur.sessionName];
                delete sessions[cur.sessionName];
            } else if (cur.level === 'window' && cur.windowIdx !== undefined) {
                const w = sessions[cur.sessionName].windows[cur.windowIdx];
                if (!w) { tree.focus();

 return; }
                const wname = await modalText(parentScreen, 'Window name', w.windowName);
                if (wname.value === null) { tree.focus();

 return; }
                const wpath = await modalText(parentScreen, 'Window cwd', w.currentPath);
                if (!wpath.value?.trim()) { tree.focus();

 return; }
                const wcmd = await modalText(parentScreen, 'Initial command', w.currentCommand);
                if (wcmd.value === null) { tree.focus();

 return; }
                w.windowName = wname.value.trim();
                w.currentPath = wpath.value.trim();
                w.currentCommand = wcmd.value.trim();
            } else if (cur.level === 'pane' && cur.windowIdx !== undefined && cur.paneIdx !== undefined) {
                const p = sessions[cur.sessionName].windows[cur.windowIdx]?.panes[cur.paneIdx];
                if (!p) { tree.focus();

 return; }
                const ppath = await modalText(parentScreen, 'Pane cwd', p.currentPath);
                if (!ppath.value?.trim()) { tree.focus();

 return; }
                const pcmd = await modalText(parentScreen, 'Pane command', p.currentCommand);
                if (pcmd.value === null) { tree.focus();

 return; }
                p.currentPath = ppath.value.trim();
                p.currentCommand = pcmd.value.trim();
            }
            refresh();
            tree.focus();
        });

        tree.key(['D'], async () => {
            const cur = rows[selectedIdx];
            if (!cur.sessionName) { tree.focus();

 return; }
            const ok = await modalConfirm(parentScreen, 'Delete', `Delete this ${cur.level}?`);
            if (!ok) { tree.focus();

 return; }
            if (cur.level === 'session') {
                delete sessions[cur.sessionName];
            } else if (cur.level === 'window' && cur.windowIdx !== undefined) {
                sessions[cur.sessionName].windows.splice(cur.windowIdx, 1);
            } else if (cur.level === 'pane' && cur.windowIdx !== undefined && cur.paneIdx !== undefined) {
                const w = sessions[cur.sessionName].windows[cur.windowIdx];
                if (w && w.panes.length > 1) w.panes.splice(cur.paneIdx, 1);
                else await modalConfirm(parentScreen, 'Notice', 'Cannot remove the last pane of a window.');
            }
            refresh();
            tree.focus();
        });

        tree.key(['enter'], async () => {
            if (Object.keys(sessions).length === 0) {
                const ok = await modalConfirm(parentScreen, 'Confirm', 'No sessions added. Save anyway?');
                if (!ok) { tree.focus();

 return; }
            }
            close(sessions);
        });

        tree.key(['escape', 'q', 'C-c'], async () => {
            if (Object.keys(sessions).length > 0) {
                const ok = await modalConfirm(parentScreen, 'Discard?', 'Discard the unsaved structure?');
                if (!ok) { tree.focus();

 return; }
            }
            close(null);
        });

        attachVerticalNavigation(tree, {
            moveBy: (delta) => {
                if (rows.length === 0) return;
                const next = Math.abs(delta) === 1
                    ? (selectedIdx + delta + rows.length) % rows.length
                    : Math.max(0, Math.min(rows.length - 1, selectedIdx + delta));
                selectedIdx = next;
                tree.select(next);
                detail.setContent(renderNodeDetails(sessions, rows[selectedIdx]));
                parentScreen.render();
            },
            top: () => {
                if (rows.length === 0) return;
                selectedIdx = 0;
                tree.select(0);
                detail.setContent(renderNodeDetails(sessions, rows[selectedIdx]));
                parentScreen.render();
            },
            bottom: () => {
                if (rows.length === 0) return;
                selectedIdx = rows.length - 1;
                tree.select(selectedIdx);
                detail.setContent(renderNodeDetails(sessions, rows[selectedIdx]));
                parentScreen.render();
            },
        });

        refresh();
        tree.focus();
        parentScreen.render();
    });
}

type SavesMode = 'servers' | 'sessions';

interface ModeConfig {
    folder: string;
    title: string;
    listLabel: string;
    headerLabel: string;
    runLoad: (fileName: string) => Promise<void>;
}

async function getModeConfig(mode: SavesMode): Promise<ModeConfig> {
    if (mode === 'servers') {
        const { loadServer, handleServerIfRunning } = await import('@/tmux/commands/loadServer');

        return {
            folder: serverFilesFolder,
            title: 'tmux · manage saves · servers',
            listLabel: 'server saves',
            headerLabel: 'server saves',
            runLoad: async (name: string) => {
                await handleServerIfRunning();
                await loadServer(name);
            },
        };
    }

    const { loadSession } = await import('@/tmux/commands/loadSession');

    return {
        folder: singleSessionFilesFolder,
        title: 'tmux · manage saves · sessions',
        listLabel: 'session saves',
        headerLabel: 'session saves',
        runLoad: async (name: string) => {
            await loadSession(name);
        },
    };
}

async function runSavesDashboard(mode: SavesMode): Promise<void> {
    const cfg = await getModeConfig(mode);
    let entries = await loadFileEntries(cfg.folder);
    let nextMode: SavesMode | null = null;

    function tabsHeader(active: SavesMode): string {
        const tab = (label: string, key: SavesMode): string => active === key
            ? `{yellow-fg}{bold}${label}{/bold}{/yellow-fg}`
            : `{gray-fg}${label}{/gray-fg}`;

        return `${tab('1 Servers', 'servers')}   ${tab('2 Sessions', 'sessions')}`;
    }

    await createListDetailDashboard<FileEntry>({
        title: cfg.title,
        initialRows: entries,
        rowKey: (e) => e.name,
        renderListItem: (e) => {
            const age = fmtAge(e.mtimeMs).padStart(4);
            const size = fmtSize(e.sizeBytes).padStart(6);

            return `${theme.date(age)}  ${theme.size(size)}  ${theme.value(escTag(e.name))}`;
        },
        listLabel: cfg.listLabel,
        listFocusName: cfg.listLabel,
        listWidth: '50%',
        headerContent: () => {
            const total = entries.length;

            return `${theme.title('tmux saves')}  ${theme.dim('|')}  ${theme.count(total)} files   ${tabsHeader(mode)}`;
        },
        detailPanels: [
            {
                label: 'summary',
                focusName: 'summary',
                paint: async (entry) => {
                    await ensureSessions(entry);

                    return renderSummary(entry);
                },
            },
            {
                label: 'details',
                focusName: 'details',
                paint: async (entry) => {
                    await ensureSessions(entry);

                    return renderDetails(entry);
                },
            },
        ],
        keymapText: () =>
            `${theme.key('1/2')} tab   ${theme.key('j/k')} nav   ${theme.key('[ ]')} ±10   ${theme.key('{ }')} ±100   ` +
            `${theme.key('enter')} load   ` +
            `${theme.key('n')} new save   ` +
            `${theme.key('d')} delete   ` +
            `${theme.key('r')} rename   ` +
            `${theme.key('R')} reload   ` +
            `${theme.key('q')} quit`,
        actions: [
            {
                keys: '1',
                handler: async (_cur, api) => {
                    if (mode === 'servers') return;
                    nextMode = 'servers';
                    api.destroy();
                },
            },
            {
                keys: '2',
                handler: async (_cur, api) => {
                    if (mode === 'sessions') return;
                    nextMode = 'sessions';
                    api.destroy();
                },
            },
            {
                keys: 'enter',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const ok = await modalConfirm(api.screen, 'Load save', `Load save "${escTag(cur.name)}"? This will run the load flow.`);
                    if (!ok) return;
                    api.destroy();
                    await cfg.runLoad(cur.name);
                },
            },
            {
                keys: 'd',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const ok = await modalConfirm(api.screen, 'Delete save', `Delete save "${escTag(cur.name)}"? This cannot be undone.`);
                    if (!ok) return;
                    try {
                        await fs.rm(cur.path);
                        entries = await loadFileEntries(cfg.folder);
                        api.setRows(entries);
                        api.refreshHeader();
                    } catch (e) {
                        await modalConfirm(api.screen, 'Error', `Delete failed: ${escTag(e instanceof Error ? e.message : String(e))}`);
                    }
                },
            },
            {
                keys: 'r',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const next = await modalText(api.screen, 'New file name', cur.name);
                    if (!next.value?.trim()) return;
                    const trimmed = next.value.trim();
                    if (trimmed === cur.name) return;
                    const newPath = `${cfg.folder}/${trimmed}`;
                    try {
                        await fs.rename(cur.path, newPath);
                        entries = await loadFileEntries(cfg.folder);
                        api.setRows(entries, { preserveKey: trimmed });
                        api.refreshHeader();
                    } catch (e) {
                        await modalConfirm(api.screen, 'Error', `Rename failed: ${escTag(e instanceof Error ? e.message : String(e))}`);
                    }
                },
            },
            {
                keys: 'R',
                handler: async (_cur, api) => {
                    entries = await loadFileEntries(cfg.folder);
                    api.setRows(entries);
                    api.refreshHeader();
                },
            },
            {
                keys: 'n',
                handler: async (_cur, api) => {
                    const built = await buildNewSaveFlow(api.screen);
                    if (!built) return;

                    let payload = built;
                    if (mode === 'sessions' && Object.keys(built).length > 1) {
                        await modalConfirm(api.screen, 'Notice', 'Single-session saves contain exactly one session. Only the first will be kept.');
                        const firstName = Object.keys(built)[0];
                        payload = { [firstName]: built[firstName] };
                    }

                    const defaultName = `manual-${getDateString()}`;
                    const name = await modalText(api.screen, 'Save as file name', defaultName);
                    if (!name.value?.trim()) return;
                    const fname = name.value.trim();
                    const newPath = `${cfg.folder}/${fname}`;
                    try {
                        await fs.writeFile(newPath, JSON.stringify(payload, null, 2), 'utf-8');
                        entries = await loadFileEntries(cfg.folder);
                        api.setRows(entries, { preserveKey: fname });
                        api.refreshHeader();
                    } catch (e) {
                        await modalConfirm(api.screen, 'Error', `Save failed: ${escTag(e instanceof Error ? e.message : String(e))}`);
                    }
                },
            },
        ],
    });

    if (nextMode) {
        await runSavesDashboard(nextMode);
    }
}

export async function manageSaves(): Promise<void> {
    await runSavesDashboard('servers');
}
