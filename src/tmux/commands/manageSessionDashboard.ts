import * as blessed from 'blessed';
import * as fs from 'fs/promises';
import { sessionFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import {
    getSavedSessionsNames,
    getSavedSessionsByFilePath,
    getDateString,
} from '@/tmux/utils/sessionUtils';
import {
    escTag,
    modalText,
    modalConfirm,
    createDashboardShell,
    attachVerticalNavigation,
    createListDetailDashboard,
} from '@/UI/dashboard';

interface FileEntry {
    name: string;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
    sessions?: TmuxSessions;
    parseError?: string;
}

async function loadFileEntries(): Promise<FileEntry[]> {
    const names = await getSavedSessionsNames();
    const entries: FileEntry[] = [];
    for (const name of names) {
        const fp = `${sessionFilesFolder}/${name}`;
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
        entry.sessions = await getSavedSessionsByFilePath(entry.path);
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
    if (!entry) return '{gray-fg}(no save selected){/gray-fg}';
    if (entry.parseError) return `{red-fg}parse error:{/red-fg}\n${escTag(entry.parseError)}`;
    if (!entry.sessions) return '{gray-fg}(loading...){/gray-fg}';
    const s = summarize(entry.sessions);
    const lines: string[] = [];
    lines.push(`{bold}${escTag(entry.name)}{/bold}`);
    lines.push('');
    lines.push(`{cyan-fg}sessions:{/cyan-fg} ${s.sessions}   {cyan-fg}windows:{/cyan-fg} ${s.windows}   {cyan-fg}panes:{/cyan-fg} ${s.panes}`);
    lines.push(`{cyan-fg}size:{/cyan-fg} ${fmtSize(entry.sizeBytes)}   {cyan-fg}saved:{/cyan-fg} ${fmtAge(entry.mtimeMs)} ago`);
    lines.push('');
    for (const sessName of Object.keys(entry.sessions)) {
        const sess = entry.sessions[sessName];
        const path = sess.windows[0]?.currentPath ?? '';
        let panes = 0;
        for (const w of sess.windows) panes += w.panes.length;
        lines.push(`  {magenta-fg}${escTag(sessName)}{/magenta-fg}  {gray-fg}w${sess.windows.length} p${panes}{/gray-fg}  ${escTag(path)}`);
    }

    return lines.join('\n');
}

function renderDetails(entry: FileEntry | undefined): string {
    if (!entry?.sessions) return '';
    const lines: string[] = [];
    for (const sessName of Object.keys(entry.sessions)) {
        const sess = entry.sessions[sessName];
        lines.push(`{bold}{magenta-fg}${escTag(sessName)}{/magenta-fg}{/bold}`);
        for (const [i, w] of sess.windows.entries()) {
            lines.push(`  {yellow-fg}#${i} ${escTag(w.windowName || '')}{/yellow-fg}  {gray-fg}${escTag(w.currentCommand || '')}{/gray-fg}`);
            lines.push(`    {gray-fg}${escTag(w.currentPath)}{/gray-fg}`);
            for (const [j, p] of w.panes.entries()) {
                lines.push(`      {green-fg}pane ${j}{/green-fg}  ${escTag(p.currentCommand || '')}  {gray-fg}${escTag(p.currentPath)}{/gray-fg}`);
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
        return [{ level: 'session', sessionName: '', label: '{gray-fg}(empty — press s to add a session){/gray-fg}' }];
    }
    for (const sname of names) {
        const sess = sessions[sname];
        rows.push({
            level: 'session',
            sessionName: sname,
            label: `{bold}{magenta-fg}◆ ${escTag(sname)}{/magenta-fg}{/bold}  {gray-fg}(${sess.windows.length}w){/gray-fg}`,
        });
        for (const [wi, w] of sess.windows.entries()) {
            rows.push({
                level: 'window',
                sessionName: sname,
                windowIdx: wi,
                label: `  {yellow-fg}▸ #${wi} ${escTag(w.windowName || '(unnamed)')}{/yellow-fg}  {gray-fg}${escTag(w.currentPath)}{/gray-fg}`,
            });
            for (const [pi, p] of w.panes.entries()) {
                rows.push({
                    level: 'pane',
                    sessionName: sname,
                    windowIdx: wi,
                    paneIdx: pi,
                    label: `      {green-fg}· pane ${pi}{/green-fg}  ${escTag(p.currentCommand || '(shell)')}  {gray-fg}${escTag(p.currentPath)}{/gray-fg}`,
                });
            }
        }
    }

    return rows;
}

function renderNodeDetails(sessions: TmuxSessions, row: BuilderRow | undefined): string {
    if (!row?.sessionName) {
        return '{gray-fg}Press {/gray-fg}{cyan-fg}s{/cyan-fg}{gray-fg} to add a new session.{/gray-fg}';
    }
    const sess = sessions[row.sessionName];
    if (!sess) return '';
    const lines: string[] = [];
    if (row.level === 'session') {
        lines.push(`{bold}Session:{/bold} {magenta-fg}${escTag(row.sessionName)}{/magenta-fg}`);
        lines.push(`{cyan-fg}windows:{/cyan-fg} ${sess.windows.length}`);
        lines.push('');
        lines.push('{cyan-fg}w{/cyan-fg} add window   {cyan-fg}e{/cyan-fg} rename   {cyan-fg}D{/cyan-fg} delete session');
    } else if (row.level === 'window' && row.windowIdx !== undefined) {
        const w = sess.windows[row.windowIdx];
        if (!w) return '';
        lines.push(`{bold}Window:{/bold} {yellow-fg}#${row.windowIdx} ${escTag(w.windowName || '(unnamed)')}{/yellow-fg}`);
        lines.push(`{cyan-fg}cwd:{/cyan-fg} ${escTag(w.currentPath)}`);
        lines.push(`{cyan-fg}cmd:{/cyan-fg} ${escTag(w.currentCommand || '(shell)')}`);
        lines.push(`{cyan-fg}panes:{/cyan-fg} ${w.panes.length}`);
        lines.push('');
        lines.push('{cyan-fg}p{/cyan-fg} add pane   {cyan-fg}e{/cyan-fg} edit fields   {cyan-fg}D{/cyan-fg} delete window');
    } else if (row.level === 'pane' && row.windowIdx !== undefined && row.paneIdx !== undefined) {
        const p = sess.windows[row.windowIdx]?.panes[row.paneIdx];
        if (!p) return '';
        lines.push(`{bold}Pane:{/bold} {green-fg}${row.paneIdx}{/green-fg} of window #${row.windowIdx}`);
        lines.push(`{cyan-fg}cwd:{/cyan-fg} ${escTag(p.currentPath)}`);
        lines.push(`{cyan-fg}cmd:{/cyan-fg} ${escTag(p.currentCommand || '(shell)')}`);
        lines.push('');
        lines.push('{cyan-fg}e{/cyan-fg} edit fields   {cyan-fg}D{/cyan-fg} delete pane');
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
                `{cyan-fg}j/k{/cyan-fg} nav   {cyan-fg}[ ]{/cyan-fg} ±10   ` +
                `{cyan-fg}s{/cyan-fg} +session   {cyan-fg}w{/cyan-fg} +window   {cyan-fg}p{/cyan-fg} +pane   ` +
                `{cyan-fg}e{/cyan-fg} edit   {cyan-fg}D{/cyan-fg} delete   ` +
                `{cyan-fg}enter{/cyan-fg} done   {cyan-fg}esc/q{/cyan-fg} cancel`,
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
                `{bold}{magenta-fg}building save{/magenta-fg}{/bold}  {gray-fg}|{/gray-fg}  ` +
                `{cyan-fg}sessions:{/cyan-fg} ${totals.s}   {cyan-fg}windows:{/cyan-fg} ${totals.w}   {cyan-fg}panes:{/cyan-fg} ${totals.p}`,
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

export async function manageSessions(): Promise<void> {
    let entries = await loadFileEntries();

    await createListDetailDashboard<FileEntry>({
        title: 'tmux · manage saves',
        initialRows: entries,
        rowKey: (e) => e.name,
        renderListItem: (e) => {
            const age = fmtAge(e.mtimeMs).padStart(4);
            const size = fmtSize(e.sizeBytes).padStart(6);

            return `{cyan-fg}${age}{/cyan-fg}  {gray-fg}${size}{/gray-fg}  ${escTag(e.name)}`;
        },
        listLabel: 'saves',
        listFocusName: 'saves',
        listWidth: '50%',
        headerContent: () => {
            const total = entries.length;
            return `{bold}{magenta-fg}tmux saves{/magenta-fg}{/bold}  {gray-fg}|{/gray-fg}  ${total} files`;
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
            `{cyan-fg}j/k{/cyan-fg} nav   {cyan-fg}[ ]{/cyan-fg} ±10   {cyan-fg}{ }{/cyan-fg} ±100   ` +
            `{cyan-fg}enter{/cyan-fg} load   ` +
            `{cyan-fg}n{/cyan-fg} new save   ` +
            `{cyan-fg}d{/cyan-fg} delete   ` +
            `{cyan-fg}r{/cyan-fg} rename   ` +
            `{cyan-fg}R{/cyan-fg} reload   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
        actions: [
            {
                keys: 'enter',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const ok = await modalConfirm(api.screen, 'Load save', `Load save "${escTag(cur.name)}"? This will run the load flow.`);
                    if (!ok) return;
                    api.destroy();
                    const { loadSession, handleSessionsIfServerIsRunning } = await import('@/tmux/commands/loadSession');
                    await handleSessionsIfServerIsRunning();
                    await loadSession(cur.name);
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
                        entries = await loadFileEntries();
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
                    const newPath = `${sessionFilesFolder}/${trimmed}`;
                    try {
                        await fs.rename(cur.path, newPath);
                        entries = await loadFileEntries();
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
                    entries = await loadFileEntries();
                    api.setRows(entries);
                    api.refreshHeader();
                },
            },
            {
                keys: 'n',
                handler: async (_cur, api) => {
                    const built = await buildNewSaveFlow(api.screen);
                    if (!built) return;
                    const defaultName = `manual-${getDateString()}`;
                    const name = await modalText(api.screen, 'Save as file name', defaultName);
                    if (!name.value?.trim()) return;
                    const fname = name.value.trim();
                    const newPath = `${sessionFilesFolder}/${fname}`;
                    try {
                        await fs.writeFile(newPath, JSON.stringify(built, null, 2), 'utf-8');
                        entries = await loadFileEntries();
                        api.setRows(entries, { preserveKey: fname });
                        api.refreshHeader();
                    } catch (e) {
                        await modalConfirm(api.screen, 'Error', `Save failed: ${escTag(e instanceof Error ? e.message : String(e))}`);
                    }
                },
            },
        ],
    });
}
