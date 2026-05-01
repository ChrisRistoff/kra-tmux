import { spawn } from 'child_process';
import * as os from 'os';
import {
    attachFocusCycleKeys,
    attachVerticalNavigation,
    createDashboardScreen,
    createDashboardShell,
    modalConfirm,
} from '@/UI/dashboard';

interface ProcessInfo {
    pid: number;
    user: string;
    cpu: string;
    mem: string;
    started: string;
    time: string;
    command: string;
    ppid: string;
    pgid: string;
    tpgid: string;
    sess: string;
    state: string;
    nice: string;
    pri: string;
    rss: string;
    vsz: string;
    tty: string;
    uid: string;
    gid: string;
    etime: string;
    lstart: string;
}

async function fetchProcesses(): Promise<ProcessInfo[]> {
    return new Promise((resolve, reject) => {
        const processes: ProcessInfo[] = [];
        // lstart is exactly 5 whitespace-separated tokens. Putting it FIRST after pid lets us
        // slice it out by fixed offsets; command goes LAST since it can contain spaces.
        const formatters = [
            'pid=', 'lstart=', 'user=', 'pcpu=', 'pmem=', 'start=', 'time=',
            'ppid=', 'pgid=', 'tpgid=', 'sess=', 'state=', 'nice=', 'pri=',
            'rss=', 'vsz=', 'tty=', 'uid=', 'gid=', 'etime=', 'command=',
        ];
        const ps = spawn('ps', ['-Ao', formatters.join(',')], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let buf = '';
        ps.stdout.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });

        ps.on('error', reject);
        ps.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ps exited with code ${code}`));
                return;
            }
            for (const line of buf.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const parts = trimmed.split(/\s+/);
                // pid(1) + lstart(5) + 18 fixed + command(>=1) = 25
                if (parts.length < 25) continue;

                const pid = parseInt(parts[0], 10);
                if (Number.isNaN(pid)) continue;

                processes.push({
                    pid,
                    lstart: parts.slice(1, 6).join(' '),
                    user: parts[6],
                    cpu: parts[7],
                    mem: parts[8],
                    started: parts[9],
                    time: parts[10],
                    ppid: parts[11],
                    pgid: parts[12],
                    tpgid: parts[13],
                    sess: parts[14],
                    state: parts[15],
                    nice: parts[16],
                    pri: parts[17],
                    rss: parts[18],
                    vsz: parts[19],
                    tty: parts[20],
                    uid: parts[21],
                    gid: parts[22],
                    etime: parts[23],
                    command: parts.slice(24).join(' '),
                });
            }
            processes.sort((a, b) => a.pid - b.pid);
            resolve(processes);
        });
    });
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

function formatBytes(bytes: number): string {
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function renderBar(percent: number, width = 30): string {
    const num = Math.min(100, Math.max(0, percent));
    const filled = Math.round((num / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}


function truncate(s: string, len: number): string {
    return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function escapeTag(s: string): string {
    return s.replace(/[{}]/g, (c) => `\\${c}`);
}

export async function openProcessManager(): Promise<void> {
    try {
        const processes = await fetchProcesses();
        let filtered: ProcessInfo[] = processes.slice();
        let displayed: ProcessInfo[] = [];
        const WINDOW_STEP = 100;
        let windowEnd = WINDOW_STEP;
        let currentIdx = -1;
        let sortMode: 'pid' | 'cpu' | 'mem' = 'pid';

        function renderHeader(): void {
            const sortLabel =
                sortMode === 'cpu' ? '{red-fg}CPU↓{/red-fg}' :
                sortMode === 'mem' ? '{yellow-fg}MEM↓{/yellow-fg}' :
                '{green-fg}PID↑{/green-fg}';
            shell.header.setContent(
                ` {magenta-fg}{bold}◆ process-manager{/bold}{/magenta-fg}   {gray-fg}sort:{/gray-fg} ${sortLabel}`,
            );
        }

        const screen = createDashboardScreen({ title: 'process-manager' });
        const shell = createDashboardShell({
            screen,
            headerContent: ' {magenta-fg}{bold}◆ process-manager{/bold}{/magenta-fg}',
            listLabel: 'processes',
            listFocusName: 'processes',
            listWidth: '40%',
            listItems: [],
            listTags: true,
            search: {
                label: 'search',
                width: '40%',
                inputOnFocus: true,
                keys: false,
            },
            detailPanels: [
                { label: 'details', focusName: 'details', top: 3, bottom: 7 },
                { label: 'stats', focusName: 'stats', height: 13, bottom: 3 },
            ],
            keymapText: `{cyan-fg}j/k{/cyan-fg} nav   {cyan-fg}/{/cyan-fg} search   {cyan-fg}c{/cyan-fg} CPU   {cyan-fg}m{/cyan-fg} MEM   {cyan-fg}p{/cyan-fg} PID   {cyan-fg}r{/cyan-fg} refresh   {cyan-fg}x{/cyan-fg} SIGTERM   {cyan-fg}X{/cyan-fg} SIGKILL   {cyan-fg}Tab{/cyan-fg} focus   {cyan-fg}q{/cyan-fg} quit`,
        });

        const { header, list, ring } = shell;
        const searchBox = shell.searchBox;
        if (searchBox === null) throw new Error('process-manager requires a search box');
        const [details, stats] = shell.detailPanels;

        let filterQuery = '';
        const cores = os.cpus().length;

        function renderListItems(): void {
            const items = displayed.map((p) => {
                return (
                    `{cyan-fg}${p.pid.toString().padStart(6)}{/cyan-fg} ` +
                    `{gray-fg}${p.user.padEnd(10)}{/gray-fg} ` +
                    `{yellow-fg}${p.cpu.padStart(5)}{/yellow-fg} ` +
                    `{yellow-fg}${p.mem.padStart(5)}{/yellow-fg} ` +
                    `{gray-fg}${p.started.padEnd(8)} ${p.time.padEnd(10)}{/gray-fg} ` +
                    `${truncate(p.command, 60)}`
                );
            });
            list.setItems(items);
            screen.render();
        }

        function rebuildDisplayed(): void {
            displayed = filtered.slice(0, Math.min(windowEnd, filtered.length));
            renderListItems();
        }

        function growWindow(): boolean {
            if (windowEnd >= filtered.length) return false;
            windowEnd = Math.min(filtered.length, windowEnd + WINDOW_STEP);
            rebuildDisplayed();
            return true;
        }

        function ensureWindowAtLeast(n: number): void {
            if (windowEnd >= n || windowEnd >= filtered.length) return;
            windowEnd = Math.min(filtered.length, Math.max(n, windowEnd + WINDOW_STEP));
            rebuildDisplayed();
        }

        function applyFilter(): void {
            const q = filterQuery.toLowerCase();
            if (q.length === 0) {
                filtered = processes.slice();
            } else {
                filtered = processes.filter(
                    (p) =>
                        String(p.pid).includes(q) ||
                        p.user.toLowerCase().includes(q) ||
                        p.command.toLowerCase().includes(q),
                );
            }
            if (sortMode === 'cpu') {
                filtered.sort((a, b) => (parseFloat(b.cpu) || 0) - (parseFloat(a.cpu) || 0));
            } else if (sortMode === 'mem') {
                filtered.sort((a, b) => (parseFloat(b.mem) || 0) - (parseFloat(a.mem) || 0));
            } else {
                filtered.sort((a, b) => a.pid - b.pid);
            }
            currentIdx = -1;
            windowEnd = WINDOW_STEP;
            rebuildDisplayed();
            if (displayed.length > 0) {
                list.select(0);
                void selectIndex(0);
            } else {
                details.setContent('{gray-fg}no matches{/gray-fg}');
                stats.setContent('');
                screen.render();
            }
        }

        function kbFmt(s: string): string {
            const n = parseInt(s, 10);
            if (Number.isNaN(n)) return s;
            if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} GB`;
            if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
            return `${n} KB`;
        }

        function paintRows(i: number): void {
            if (currentIdx !== i) return;
            const p = displayed[i];
            if (p === undefined) return;
            const detailText =
                `PID:            ${p.pid}\n` +
                `Parent PID:     ${p.ppid}\n` +
                `Process Group:  ${p.pgid}   (terminal fg pgid: ${p.tpgid})\n` +
                `Session:        ${p.sess}\n` +
                `User:           ${p.user} (uid ${p.uid}, gid ${p.gid})\n` +
                `State:          ${p.state}\n` +
                `TTY:            ${p.tty}\n` +
                `Priority:       ${p.pri} (nice ${p.nice})\n` +
                `CPU:            ${p.cpu}%\n` +
                `Memory:         ${p.mem}%   RSS ${kbFmt(p.rss)}   VSZ ${kbFmt(p.vsz)}\n` +
                `Started:        ${p.lstart}\n` +
                `Elapsed Time:   ${p.etime}\n` +
                `CPU Time:       ${p.time}\n` +
                `\n` +
                `Command:\n${p.command}`;
            details.setContent(escapeTag(detailText));
            details.setScrollPerc(0);

            const totalCpu = filtered.reduce((acc, x) => acc + (parseFloat(x.cpu) || 0), 0);
            const totalMem = filtered.reduce((acc, x) => acc + (parseFloat(x.mem) || 0), 0);
            const total = os.totalmem();
            const used = total - os.freemem();
            const load = os.loadavg();
            const cpuPct = parseFloat(p.cpu) || 0;
            const memPct = parseFloat(p.mem) || 0;
            const sysMemPct = (used / total) * 100;
            const statsText =
                `{cyan-fg}Process{/cyan-fg}\n` +
                `CPU   ${renderBar(cpuPct)} ${cpuPct.toFixed(1)}%\n` +
                `Mem   ${renderBar(memPct)} ${memPct.toFixed(1)}%\n` +
                `\n` +
                `{cyan-fg}System{/cyan-fg}\n` +
                `Load avg:    ${load[0].toFixed(2)}  ${load[1].toFixed(2)}  ${load[2].toFixed(2)}   (${cores} cores)\n` +
                `Memory   ${renderBar(sysMemPct)} ${formatBytes(used)} / ${formatBytes(total)} (${sysMemPct.toFixed(1)}%)\n` +
                `Uptime:      ${formatUptime(os.uptime())}\n` +
                `Processes:   ${filtered.length} shown / ${processes.length} total   sum CPU ${totalCpu.toFixed(1)}%   sum Mem ${totalMem.toFixed(1)}%`;
            stats.setContent(statsText);
            stats.setScrollPerc(0);
            screen.render();
        }

        function selectIndex(i: number): void {
            if (i < 0 || i >= displayed.length || i === currentIdx) return;
            currentIdx = i;
            if (i >= displayed.length - 20) growWindow();
            paintRows(i);
        }

        function flashHeader(msg: string): void {
            const originalContent = header.content as string;
            header.setContent(msg);
            screen.render();
            setTimeout(() => {
                header.setContent(originalContent);
                screen.render();
            }, 1500);
        }

        async function confirmKill(signal: string): Promise<void> {
            if (displayed.length === 0) return;
            const p = displayed[currentIdx >= 0 ? currentIdx : 0];
            const ok = await modalConfirm(
                screen,
                `Kill process ${signal}`,
                `Send ${signal} to PID ${p.pid} (${p.command})?`,
            );
            if (!ok) return;

            try {
                process.kill(p.pid, signal as NodeJS.Signals);
                // Remove from both arrays
                const idx = processes.indexOf(p);
                if (idx >= 0) processes.splice(idx, 1);
                const idx2 = displayed.indexOf(p);
                if (idx2 >= 0) displayed.splice(idx2, 1);
                const idx3 = filtered.indexOf(p);
                if (idx3 >= 0) filtered.splice(idx3, 1);

                // Re-render and adjust selection
                if (currentIdx >= displayed.length && currentIdx > 0) currentIdx--;
                renderListItems();
                if (displayed.length > 0) {
                    list.select(currentIdx);
                    void selectIndex(currentIdx);
                }
                flashHeader(`✓ sent ${signal} to PID ${p.pid}`);
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === 'ESRCH') {
                    // Process already gone
                    const idx = displayed.indexOf(p);
                    if (idx >= 0) displayed.splice(idx, 1);
                    const idx2 = filtered.indexOf(p);
                    if (idx2 >= 0) filtered.splice(idx2, 1);
                    const idx3 = processes.indexOf(p);
                    if (idx3 >= 0) processes.splice(idx3, 1);
                    if (currentIdx >= displayed.length && currentIdx > 0) currentIdx--;
                    renderListItems();
                    if (displayed.length > 0) {
                        list.select(currentIdx);
                        void selectIndex(currentIdx);
                    }
                    flashHeader(`✓ process ${p.pid} was already gone`);
                } else {
                    flashHeader(`✗ failed to kill: ${err.message}`);
                }
            }
            list.focus();
            screen.render();
        }

        list.on('select item', (_item, idx) => {
            selectIndex(idx);
        });

        attachVerticalNavigation(list, {
            moveBy: (delta) => {
                if (filtered.length === 0) return;
                const cur = currentIdx >= 0 ? currentIdx : 0;
                let target = cur + delta;
                if (target < 0) target = 0;
                if (target >= filtered.length) target = filtered.length - 1;
                ensureWindowAtLeast(target + 21);
                target = Math.min(target, displayed.length - 1);
                list.select(target);
                screen.render();
            },
            top: () => {
                if (displayed.length === 0) return;
                list.select(0);
                screen.render();
            },
            bottom: () => {
                if (filtered.length === 0) return;
                ensureWindowAtLeast(filtered.length);
                list.select(displayed.length - 1);
                screen.render();
            },
        });

        list.key(['/', 's'], () => {
            searchBox.focus();
            searchBox.readInput();
        });

        list.key(['x'], () => {
            void confirmKill('SIGTERM');
        });

        list.key(['X', 'S-x'], () => {
            void confirmKill('SIGKILL');
        });

        list.key(['c'], () => {
            sortMode = 'cpu';
            renderHeader();
            applyFilter();
        });

        list.key(['m'], () => {
            sortMode = 'mem';
            renderHeader();
            applyFilter();
        });

        list.key(['p'], () => {
            sortMode = 'pid';
            renderHeader();
            applyFilter();
        });

        list.key(['r'], async () => {
            header.setContent(
                ' {magenta-fg}{bold}◆ process-manager{/bold}{/magenta-fg}   {yellow-fg}◜ refreshing…{/yellow-fg}',
            );
            screen.render();

            try {
                const newProcesses = await fetchProcesses();
                const oldPid = displayed[currentIdx]?.pid;

                processes.length = 0;
                processes.push(...newProcesses);
                applyFilter();
                applyFilter();

                if (oldPid !== undefined) {
                    const newIdx = filtered.findIndex((p) => p.pid === oldPid);
                    ensureWindowAtLeast(newIdx + 21);
                    if (newIdx >= 0) {
                        currentIdx = -1;
                        list.select(newIdx);
                    }
                }

                renderListItems();
                if (displayed.length > 0) {
                    const idx = currentIdx >= 0 ? currentIdx : 0;
                    currentIdx = -1;
                    void selectIndex(idx);
                }
            } catch (e) {
                flashHeader(`✗ refresh failed: ${(e as Error).message}`);
            }

            header.setContent(' {magenta-fg}{bold}◆ process-manager{/bold}{/magenta-fg}');
            screen.render();
        });

        searchBox.on('keypress', () => {
            setImmediate(() => {
                const v = searchBox.getValue();
                if (v !== filterQuery) {
                    filterQuery = v;
                    applyFilter();
                }
            });
        });
        searchBox.key(['enter'], () => {
            ring.focusAt(0);
        });
        searchBox.key(['escape'], () => {
            searchBox.clearValue();
            if (filterQuery) {
                filterQuery = '';
                applyFilter();
            }
            ring.focusAt(0);
        });

        // Initial render
        applyFilter();

        attachFocusCycleKeys(screen, ring);
        ring.focusAt(0);
        screen.render();
    } catch (error) {
        console.error('Failed to render process manager dashboard:', error);
        throw error;
    }
}
