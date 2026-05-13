import * as bash from '@/utils/bashHelper';
import { escTag } from '@/UI/dashboard/escTag';
import { theme } from '@/UI/dashboard/theme';
import { createListDetailDashboard } from '@/UI/dashboard/listDetailDashboard';
import { modalText, modalConfirm } from '@/UI/dashboard/modals';

type FindMode = 'sessions' | 'windows';

interface SessionRow {
    name: string;
    windowCount: number;
    paneCount: number;
    attached: boolean;
    activity: number;
    cwd: string;
}

interface WindowRow {
    session: string;
    index: number;
    name: string;
    panes: number;
    active: boolean;
    cwd: string;
    command: string;
}

async function listSessionRows(): Promise<SessionRow[]> {
    const [sessRes, paneRes] = await Promise.all([
        bash.execCommand(
            `tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_path}'`
        ).catch(() => ({ stdout: '', stderr: '' })),
        bash.execCommand(
            `tmux list-panes -a -F '#{session_name}'`
        ).catch(() => ({ stdout: '', stderr: '' })),
    ]);

    const stdout = sessRes.stdout.toString().trim();
    if (!stdout) return [];

    const paneCounts = new Map<string, number>();
    for (const line of paneRes.stdout.toString().trim().split('\n')) {
        if (!line) continue;
        paneCounts.set(line, (paneCounts.get(line) ?? 0) + 1);
    }

    const rows: SessionRow[] = [];
    for (const line of stdout.split('\n')) {
        const [name, windows, attached, activity, cwd] = line.split('\t');
        rows.push({
            name,
            windowCount: parseInt(windows, 10) || 0,
            paneCount: paneCounts.get(name) ?? 0,
            attached: parseInt(attached, 10) > 0,
            activity: parseInt(activity, 10) || 0,
            cwd: cwd || '',
        });
    }

    return rows;
}

async function listWindowRows(): Promise<WindowRow[]> {
    let stdout = '';
    try {
        const r = await bash.execCommand(
            `tmux list-windows -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}\t#{pane_current_path}\t#{pane_current_command}'`
        );
        stdout = r.stdout.toString().trim();
    } catch {
        return [];
    }
    if (!stdout) return [];

    return stdout.split('\n').map((line) => {
        const [session, index, name, panes, active, cwd, command] = line.split('\t');

        return {
            session,
            index: parseInt(index, 10) || 0,
            name: name || '',
            panes: parseInt(panes, 10) || 0,
            active: active === '1',
            cwd: cwd || '',
            command: command || '',
        };
    });
}


async function capturePane(target: string): Promise<string> {
    try {
        const r = await bash.execCommand(`tmux capture-pane -ep -t '${target}'`);

        return r.stdout.toString();
    } catch {
        return '';
    }
}

function fuzzyScore(haystack: string, needle: string): number {
    if (!needle) return 0;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();

    const idx = h.indexOf(n);
    if (idx >= 0) return 1000 - idx;

    let hi = 0;
    let matched = 0;
    let lastMatch = -2;
    let score = 0;
    for (const c of n) {
        let found = -1;
        for (let i = hi; i < h.length; i++) {
            if (h[i] === c) { found = i; break; }
        }
        if (found < 0) return -1;
        matched++;
        if (lastMatch >= 0 && found === lastMatch + 1) score += 5;
        if (found === 0 || /[\s/_\-.:]/.test(h[found - 1] ?? '')) score += 3;
        score += 1;
        lastMatch = found;
        hi = found + 1;
    }

    return matched === n.length ? score : -1;
}

function fuzzyMatch(haystack: string, needle: string): boolean {
    return fuzzyScore(haystack, needle) >= 0;
}

function tabsHeader(active: FindMode): string {
    const tab = (label: string, key: FindMode): string => active === key
        ? `{yellow-fg}{bold}${label}{/bold}{/yellow-fg}`
        : `{gray-fg}${label}{/gray-fg}`;

    return `${tab('1 Sessions', 'sessions')}   ${tab('2 Windows', 'windows')}`;
}

function renderSessionSummary(row: SessionRow): string {
    const lines: string[] = [];
    lines.push(`${theme.label('session')}  ${theme.value(escTag(row.name))}` +
        (row.attached ? `  ${theme.success('(attached)')}` : ''));
    lines.push(`${theme.label('cwd')}      ${theme.path(escTag(row.cwd))}`);
    lines.push(`${theme.label('windows')}  ${theme.count(row.windowCount)}`);
    lines.push(`${theme.label('panes')}    ${theme.count(row.paneCount)}`);

    return lines.join('\n');
}

function renderSessionWindowsFromCache(row: SessionRow, all: WindowRow[]): string {
    const wins = all.filter((w) => w.session === row.name);
    if (wins.length === 0) return theme.dim('(no windows)');
    const lines: string[] = [];
    for (const w of wins) {
        const marker = w.active ? theme.selected('*') : ' ';
        lines.push(
            `${marker} ${theme.count(String(w.index).padStart(2))}  ` +
            `${theme.value(escTag(w.name).padEnd(20))}  ` +
            `${theme.dim(escTag(w.command).padEnd(12))}  ` +
            `${theme.path(escTag(w.cwd))}`
        );
    }

    return lines.join('\n');
}


function renderWindowHeader(row: WindowRow): string {
    const lines: string[] = [];
    lines.push(`${theme.label('target')}   ${theme.value(escTag(`${row.session}:${row.index}`))}` +
        (row.active ? `  ${theme.success('(active)')}` : ''));
    lines.push(`${theme.label('name')}     ${theme.value(escTag(row.name))}`);
    lines.push(`${theme.label('command')}  ${theme.dim(escTag(row.command))}`);
    lines.push(`${theme.label('cwd')}      ${theme.path(escTag(row.cwd))}`);
    lines.push(`${theme.label('panes')}    ${theme.count(row.panes)}`);

    return lines.join('\n');
}

async function renderWindowPreview(row: WindowRow): Promise<string> {
    const target = `${row.session}:${row.index}`;
    const header = renderWindowHeader(row);
    const capture = await capturePane(target);
    const captureBlock = capture.trim()
        ? escTag(capture)
        : theme.dim('(no preview available)');

    return `${header}\n\n${theme.section('preview')}\n${captureBlock}`;
}

async function switchToSession(name: string): Promise<void> {
    await bash.execCommand(`tmux switch-client -t '${name}'`);
}

async function switchToWindow(session: string, index: number): Promise<void> {
    await bash.execCommand(`tmux switch-client -t '${session}:${index}'`);
}

interface CurrentLocation {
    session: string;
    lastWindowIndex: number | null;
}

async function getCurrentLocation(): Promise<CurrentLocation> {
    let session = '';
    try {
        const r = await bash.execCommand(`tmux display-message -p '#S'`);
        session = r.stdout.toString().trim();
    } catch {
        return { session: '', lastWindowIndex: null };
    }
    let lastWindowIndex: number | null = null;
    try {
        const r = await bash.execCommand(
            `tmux list-windows -t '${session}' -F '#{window_index}\t#{window_last_flag}'`
        );
        for (const line of r.stdout.toString().trim().split('\n')) {
            const [idx, flag] = line.split('\t');
            if (flag === '1') {
                lastWindowIndex = parseInt(idx, 10);
                break;
            }
        }
    } catch {
        /* ignore */
    }

    return { session, lastWindowIndex };
}

async function killSession(name: string): Promise<void> {
    await bash.execCommand(`tmux kill-session -t '${name}'`);
}

async function killWindow(session: string, index: number): Promise<void> {
    await bash.execCommand(`tmux kill-window -t '${session}:${index}'`);
}

async function createSession(name: string): Promise<void> {
    await bash.execCommand(`tmux new-session -d -s '${name.replace(/'/g, "'\\''")}'`);
}

async function createWindow(session: string, name: string): Promise<void> {
    const safeName = name.replace(/'/g, "'\\''");
    await bash.execCommand(`tmux new-window -d -t '${session}' -n '${safeName}'`);
}

async function runSessionsTab(): Promise<FindMode | null> {
    let rows: SessionRow[] = [];
    let windowsCache: WindowRow[] = [];
    let nextMode: FindMode | null = null;

    await createListDetailDashboard<SessionRow>({
        title: 'tmux · find · sessions',
        initialRows: rows,
        rowKey: (r) => r.name,
        renderListItem: (r) => {
            const mark = r.attached ? theme.success('●') : theme.dim('○');
            const wcount = theme.count(`${r.windowCount}w`).padEnd(4);
            const pcount = theme.dim(`${r.paneCount}p`).padEnd(4);

            return `${mark} ${wcount} ${pcount} ${theme.value(escTag(r.name))}`;
        },
        listLabel: 'sessions',
        listFocusName: 'sessions',
        listWidth: '40%',
        headerContent: () => `${theme.title('tmux find')}  ${theme.dim('|')}  ` +
            `${theme.count(rows.length)} sessions   ${tabsHeader('sessions')}`,
        filter: {
            label: 'fuzzy',
            mode: 'live',
            match: (row, q) => fuzzyMatch(row.name, q) || fuzzyMatch(row.cwd, q),
        },
        detailPanels: [
            {
                label: 'session',
                focusName: 'session',
                paint: (r) => renderSessionSummary(r),
            },
            {
                label: 'windows',
                focusName: 'windows',
                paint: (r) => renderSessionWindowsFromCache(r, windowsCache),
            },
        ],
        keymapText: () =>
            `${theme.key('1/2')} tab   ${theme.key('/')} fuzzy   ${theme.key('j/k')} nav   ` +
            `${theme.key('enter')} switch   ${theme.key('n')} new   ${theme.key('x')} kill   ` +
            `${theme.key('R')} reload   ${theme.key('q')} quit`,
        onReady: async (api) => {
            const [loaded, windowsLoaded, loc] = await Promise.all([
                listSessionRows(),
                listWindowRows(),
                getCurrentLocation(),
            ]);
            rows = loaded;
            windowsCache = windowsLoaded;
            api.setRows(rows);
            api.refreshHeader();
            if (loc.session) api.selectByKey(loc.session);
        },
        actions: [
            {
                keys: '1',
                handler: () => { /* already here */ },
            },
            {
                keys: '2',
                handler: (_cur, api) => { nextMode = 'windows'; api.destroy(); },
            },
            {
                keys: 'enter',
                handler: async (cur, api) => {
                    if (!cur) return;
                    api.destroy();
                    await switchToSession(cur.name);
                },
            },
            {
                keys: 'R',
                handler: async (_cur, api) => {
                    [rows, windowsCache] = await Promise.all([listSessionRows(), listWindowRows()]);
                    api.setRows(rows);
                    api.repaintDetails();
                    api.refreshHeader();
                },
            },
            {
                keys: 'x',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const here = await getCurrentLocation();
                    if (cur.name === here.session) {
                        api.flashHeader(`cannot kill current session '${cur.name}'`, 1800);

                        return;
                    }
                    const ok = await modalConfirm(api.screen, 'Kill session', `Kill session '${cur.name}'? This destroys all its windows.`);
                    if (!ok) return;
                    try {
                        await killSession(cur.name);
                    } catch (e) {
                        api.flashHeader(`kill failed: ${(e as Error).message}`, 2000);

                        return;
                    }
                    [rows, windowsCache] = await Promise.all([listSessionRows(), listWindowRows()]);
                    api.setRows(rows);
                    api.repaintDetails();
                    api.refreshHeader();
                    api.flashHeader(`killed session '${cur.name}'`, 1500);
                },
            },
            {
                keys: 'n',
                handler: async (_cur, api) => {
                    const res = await modalText(api.screen, 'New session name', '', { hint: 'enter create · esc cancel' });
                    const name = (res.value ?? '').trim();
                    if (!name) return;
                    try {
                        await createSession(name);
                    } catch (e) {
                        api.flashHeader(`create failed: ${(e as Error).message}`, 2000);

                        return;
                    }
                    [rows, windowsCache] = await Promise.all([listSessionRows(), listWindowRows()]);
                    api.setRows(rows);
                    api.repaintDetails();
                    api.refreshHeader();
                    api.selectByKey(name);
                    api.flashHeader(`created session '${name}'`, 1500);
                },
            },
        ],
    });

    return nextMode;
}

async function runWindowsTab(): Promise<FindMode | null> {
    let rows: WindowRow[] = [];
    let nextMode: FindMode | null = null;

    await createListDetailDashboard<WindowRow>({
        title: 'tmux · find · windows',
        initialRows: rows,
        rowKey: (r) => `${r.session}:${r.index}`,
        renderListItem: (r) => {
            const mark = r.active ? theme.success('●') : theme.dim('○');
            const target = theme.count(`${r.session}:${r.index}`);

            return `${mark} ${target}  ${theme.value(escTag(r.name).padEnd(18))} ${theme.dim(escTag(r.command))}`;
        },
        listLabel: 'windows',
        listFocusName: 'windows',
        listWidth: '50%',
        headerContent: () => `${theme.title('tmux find')}  ${theme.dim('|')}  ` +
            `${theme.count(rows.length)} windows   ${tabsHeader('windows')}`,
        filter: {
            label: 'fuzzy',
            mode: 'live',
            match: (row, q) => fuzzyMatch(`${row.session}:${row.index} ${row.name} ${row.command} ${row.cwd}`, q),
        },
        detailPanels: [
            {
                label: 'preview',
                focusName: 'preview',
                paint: async (r) => await renderWindowPreview(r),
            },
        ],
        keymapText: () =>
            `${theme.key('1/2')} tab   ${theme.key('/')} fuzzy   ${theme.key('j/k')} nav   ` +
            `${theme.key('enter')} switch   ${theme.key('n')} new   ${theme.key('x')} kill   ` +
            `${theme.key('R')} reload   ${theme.key('q')} quit`,
        onReady: async (api) => {
            const [loaded, loc] = await Promise.all([listWindowRows(), getCurrentLocation()]);
            rows = loaded;
            api.setRows(rows);
            api.refreshHeader();
            if (loc.session && loc.lastWindowIndex !== null) {
                api.selectByKey(`${loc.session}:${loc.lastWindowIndex}`);
            }
        },
        actions: [
            {
                keys: '1',
                handler: (_cur, api) => { nextMode = 'sessions'; api.destroy(); },
            },
            {
                keys: '2',
                handler: () => { /* already here */ },
            },
            {
                keys: 'enter',
                handler: async (cur, api) => {
                    if (!cur) return;
                    api.destroy();
                    await switchToWindow(cur.session, cur.index);
                },
            },
            {
                keys: 'R',
                handler: async (_cur, api) => {
                    rows = await listWindowRows();
                    api.setRows(rows);
                    api.refreshHeader();
                },
            },
            {
                keys: 'x',
                handler: async (cur, api) => {
                    if (!cur) return;
                    const here = await getCurrentLocation();
                    if (cur.session === here.session && cur.name === 'find-session') {
                        api.flashHeader('cannot kill the picker window', 1800);

                        return;
                    }
                    const ok = await modalConfirm(
                        api.screen,
                        'Kill window',
                        `Kill window '${cur.session}:${cur.index} ${cur.name}'?`,
                    );
                    if (!ok) return;
                    try {
                        await killWindow(cur.session, cur.index);
                    } catch (e) {
                        api.flashHeader(`kill failed: ${(e as Error).message}`, 2000);

                        return;
                    }
                    rows = await listWindowRows();
                    api.setRows(rows);
                    api.refreshHeader();
                    api.flashHeader(`killed ${cur.session}:${cur.index}`, 1500);
                },
            },
            {
                keys: 'n',
                handler: async (cur, api) => {
                    const targetSession = cur?.session;
                    if (!targetSession) {
                        api.flashHeader('no session context for new window', 1800);

                        return;
                    }
                    const res = await modalText(
                        api.screen,
                        `New window in '${targetSession}'`,
                        '',
                        { hint: 'enter create · esc cancel' },
                    );
                    const name = (res.value ?? '').trim();
                    if (!name) return;
                    try {
                        await createWindow(targetSession, name);
                    } catch (e) {
                        api.flashHeader(`create failed: ${(e as Error).message}`, 2000);

                        return;
                    }
                    rows = await listWindowRows();
                    api.setRows(rows);
                    api.refreshHeader();
                    const created = rows.find((r) => r.session === targetSession && r.name === name);
                    if (created) api.selectByKey(`${created.session}:${created.index}`);
                    api.flashHeader(`created ${targetSession}:${name}`, 1500);
                },
            },
        ],
    });

    return nextMode;
}

export async function findSession(): Promise<void> {
    let mode: FindMode = 'sessions';
    for (;;) {
        const next: FindMode | null = mode === 'sessions' ? await runSessionsTab() : await runWindowsTab();
        if (!next) return;
        mode = next;
    }
}
