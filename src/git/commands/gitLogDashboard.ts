import * as blessed from 'blessed';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as bash from '@/utils/bashHelper';
import { GIT_COMMANDS } from '@/git/config/gitConstants';
import {
    attachFocusCycleKeys,
    attachVerticalNavigation,
    awaitScreenDestroy,
    createDashboardScreen,
    createDashboardShell,
} from '@/UI/dashboard';
import { browseFiles, runInherit } from '@/UI/dashboard/screen';

interface Commit {
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    relDate: string;
    isoDate: string;
    refs: string;
    subject: string;
    body: string;
}

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

function parseRecord(r: string): Commit {
    const f = r.replace(/^\n+/, '').split(FIELD_SEP);

    return {
        hash: f[0] ?? '',
        shortHash: f[1] ?? '',
        author: f[2] ?? '',
        email: f[3] ?? '',
        relDate: f[4] ?? '',
        isoDate: f[5] ?? '',
        refs: f[6] ?? '',
        subject: f[7] ?? '',
        body: (f[8] ?? '').trim(),
    };
}

async function streamCommits(
    onChunk: (added: Commit[], total: number) => void,
): Promise<Commit[]> {
    const fmt = ['%H', '%h', '%an', '%ae', '%ar', '%aI', '%D', '%s', '%b'].join(FIELD_SEP);
    const all: Commit[] = [];
    let buffer = '';

    return new Promise((resolve, reject) => {
        const p = spawn('git', ['log', `--pretty=format:${fmt}${RECORD_SEP}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            const parts = buffer.split(RECORD_SEP);
            buffer = parts.pop() ?? '';
            const added: Commit[] = [];
            for (const part of parts) {
                if (part.trim().length === 0) continue;
                const c = parseRecord(part);
                all.push(c);
                added.push(c);
            }
            if (added.length > 0) onChunk(added, all.length);
        });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`git log exited with code ${code ?? 'null'}`));

                return;
            }
            if (buffer.trim().length > 0) {
                const c = parseRecord(buffer);
                all.push(c);
                onChunk([c], all.length);
            }
            resolve(all);
        });
    });
}

async function loadStat(hash: string): Promise<string> {
    try {
        const { stdout } = await bash.execCommand(`git show --stat --format='' ${hash}`);

        return stdout.trim();
    } catch (e) {
        return `Failed to load stat: ${(e as Error).message}`;
    }
}

async function loadGraph(limit = 300): Promise<string> {
    try {
        const { stdout } = await bash.execCommand(
            `git log --graph --all --decorate --format='%h\x1f%d\x1f%s\x1f%an\x1f%ar' -n ${limit}`,
        );

        return stdout;
    } catch (e) {
        return `Failed to load graph: ${(e as Error).message}`;
    }
}

async function loadCommitFiles(hash: string): Promise<string[]> {
    try {
        const { stdout } = await bash.execCommand(
            `git show --name-only --pretty=format: ${hash}`,
        );

        return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function formatCommitRow(c: Commit, width: number): string {
    const hash = `{yellow-fg}${c.shortHash}{/yellow-fg}`;
    const refs = c.refs ? ` {green-fg}(${truncate(c.refs, 24)}){/green-fg}` : '';
    const date = `{cyan-fg}${pad(c.relDate, 14)}{/cyan-fg}`;
    const subjMax = Math.max(10, width - 8 - 14 - (c.refs ? 26 : 0) - 4);
    const subject = `{white-fg}${escape(truncate(c.subject, subjMax))}{/white-fg}`;

    return `${hash} ${date} ${subject}${refs}`;
}

function pad(s: string, n: number): string {
    if (s.length >= n) return s.slice(0, n);

    return s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;

    return s.slice(0, Math.max(1, n - 1)) + '…';
}

function escape(s: string): string {
    return s.replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

function renderDetails(c: Commit): string {
    const refs = c.refs ? `{green-fg}${escape(c.refs)}{/green-fg}` : '{gray-fg}(no refs){/gray-fg}';
    const lines = [
        `{yellow-fg}{bold}commit{/bold}{/yellow-fg} ${c.hash}`,
        `{cyan-fg}author{/cyan-fg}  ${escape(c.author)} {gray-fg}<${escape(c.email)}>{/gray-fg}`,
        `{cyan-fg}date{/cyan-fg}    ${escape(c.isoDate)}  {gray-fg}(${escape(c.relDate)}){/gray-fg}`,
        `{cyan-fg}refs{/cyan-fg}    ${refs}`,
        '',
        `{white-fg}{bold}${escape(c.subject)}{/bold}{/white-fg}`,
    ];
    if (c.body) {
        lines.push('');
        lines.push(escape(c.body));
    }

    return lines.join('\n');
}

function renderGraph(raw: string, currentShort: string): string {
    if (!raw.trim()) return '{gray-fg}(empty graph){/gray-fg}';
    const railSwap = (s: string): string =>
        s
            .replace(/\*/g, '\u0001')
            .replace(/\|/g, '│')
            .replace(/\//g, '╱')
            .replace(/\\/g, '╲')
            .replace(/_/g, '─')
            .replace(/\u0001/g, '●');
    const colorRails = (s: string): string =>
        escape(s)
            .replace(/●/g, '{magenta-fg}{bold}●{/bold}{/magenta-fg}')
            .replace(/([│╱╲─])/g, '{cyan-fg}$1{/cyan-fg}');

    return raw
        .split('\n')
        .map((line) => {
            const sepIdx = line.indexOf('\x1f');
            if (sepIdx < 0) {
                return colorRails(railSwap(line));
            }
            const rails = line.slice(0, sepIdx).replace(/[^\s*|/\\_]+$/, '');
            const trailingPrefix = line.slice(rails.length, sepIdx);
            const fields = line.slice(sepIdx + 1).split('\x1f');
            const hash = trailingPrefix.trim();
            const refsRaw = (fields[0] ?? '').trim();
            const subject = fields[1] ?? '';
            const author = fields[2] ?? '';
            const age = fields[3] ?? '';

            const railsOut = colorRails(railSwap(rails));
            const hashOut = `{yellow-fg}{bold}${escape(hash)}{/bold}{/yellow-fg}`;
            const refsOut = refsRaw
                ? ` {green-fg}${escape(refsRaw)}{/green-fg}`
                : '';
            const subjOut = ` {white-fg}${escape(truncate(subject, 80))}{/white-fg}`;
            const metaOut = author
                ? ` {gray-fg}· ${escape(author)}, ${escape(age)}{/gray-fg}`
                : '';
            const content = `${hashOut}${refsOut}${subjOut}${metaOut}`;

            if (currentShort && hash === currentShort) {
                const stripped = `${hash}${refsRaw ? ' ' + refsRaw : ''} ${truncate(subject, 80)}${author ? ' · ' + author + ', ' + age : ''}`;

                return `${railsOut}{yellow-bg}{black-fg}${escape(stripped)}{/black-fg}{/yellow-bg}`;
            }

            return `${railsOut}${content}`;
        })
        .join('\n');
}




async function viewCommitFileDiff(
    screen: blessed.Widgets.Screen,
    commit: Commit,
    file: string,
): Promise<void> {
    let hasParent = true;
    try {
        await bash.execCommand(`git rev-parse --verify --quiet ${commit.hash}^`);
    } catch {
        hasParent = false;
    }
    const buf = `${commit.hash}:${file}`;
    const args = hasParent
        ? ['-c', `Gedit ${buf}`, '-c', `Gvdiffsplit ${commit.hash}~`]
        : ['-c', `Gedit ${buf}`];
    try {
        await runInherit('nvim', args, screen);
    } catch {
        const tmp = path.join(os.tmpdir(), `kra-gitlog-${commit.shortHash}-${path.basename(file)}.diff`);
        try {
            const { stdout } = await bash.execCommand(
                `git show --pretty=format: ${commit.hash} -- '${file.replace(/'/g, "'\\''")}'`,
            );
            await fs.promises.writeFile(tmp, stdout || `(no diff for ${file})\n`);
            await runInherit('nvim', ['-R', '-c', 'set filetype=diff', tmp], screen);
        } finally {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        }
    }
}

export async function gitLogDashboard(): Promise<void> {
    const [branch, topLevel, graphRaw] = await Promise.all([
        bash.execCommand(GIT_COMMANDS.GET_BRANCH).then((r) => r.stdout.trim()),
        bash.execCommand(GIT_COMMANDS.GET_TOP_LEVEL).then((r) => r.stdout.trim()),
        loadGraph(300),
    ]);

    const commits: Commit[] = [];


    const screen = createDashboardScreen({ title: `git log · ${branch}` });

    const shell = createDashboardShell({
        screen,
        listLabel: 'commits',
        listFocusName: 'commits',
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
            { label: 'commit details', focusName: 'details' },
            { label: 'files changed (this commit)', focusName: 'files', content: '{gray-fg}Loading…{/gray-fg}' },
            { label: 'branch graph', focusName: 'graph' },
        ],
        keymapText: () =>
            `{cyan-fg}j/k{/cyan-fg} nav   {cyan-fg}[ ]{/cyan-fg} ±10   {cyan-fg}{ }{/cyan-fg} ±100   ` +
            `{cyan-fg}enter{/cyan-fg} files in commit   ` +
            `{cyan-fg}d{/cyan-fg} full diff   ` +
            `{cyan-fg}s{/cyan-fg} / {cyan-fg}/{/cyan-fg} search   ` +
            `{cyan-fg}y{/cyan-fg} yank hash   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
    });
    const { header, list, ring } = shell;
    const searchBox = shell.searchBox;
    if (searchBox === null) throw new Error('git log dashboard requires a search box');
    const [details, stat, graph] = shell.detailPanels;

    let loading = true;
    function setHeader(): void {
        const head: Commit | undefined = commits.length > 0 ? commits[0] : undefined;
        const headPart = head
            ? `   {cyan-fg}HEAD{/cyan-fg} {yellow-fg}${head.shortHash}{/yellow-fg} {gray-fg}${escape(truncate(head.subject, 40))}{/gray-fg}`
            : '';
        const loadingPart = loading
            ? `   {yellow-fg}◜ loading…{/yellow-fg}`
            : '';
        header.setContent(
            ` {magenta-fg}{bold}◆ git log{/bold}{/magenta-fg}` +
            `   {cyan-fg}branch{/cyan-fg} {yellow-fg}${escape(branch)}{/yellow-fg}` +
            `   {cyan-fg}repo{/cyan-fg} {white-fg}${escape(topLevel)}{/white-fg}` +
            `   {cyan-fg}commits{/cyan-fg} {yellow-fg}${commits.length}{/yellow-fg}` +
            headPart +
            loadingPart,
        );
    }
    setHeader();
    let filterQuery = '';
    let filtered: Commit[] = commits.slice();
    let displayed: Commit[] = [];
    const WINDOW_STEP = 200;
    let windowEnd = WINDOW_STEP;

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
        const q = filterQuery.trim().toLowerCase();
        if (!q) {
            filtered = commits.slice();
        } else {
            filtered = commits.filter((c) =>
                c.subject.toLowerCase().includes(q)
                || c.author.toLowerCase().includes(q)
                || c.hash.toLowerCase().includes(q)
                || c.shortHash.toLowerCase().includes(q),
            );
        }
        windowEnd = WINDOW_STEP;
        rebuildDisplayed();
        if (displayed.length > 0) {
            currentIdx = -1;
            list.select(0);
            void selectIndex(0);
        } else {
            currentIdx = -1;
            details.setContent('{gray-fg}no matches{/gray-fg}');
            stat.setContent('');
            graph.setContent('');
        }
        screen.render();
    }

    function renderListItems(): void {
        const w = (list.width as number) - 4;
        list.setItems(displayed.map((c) => formatCommitRow(c, w)));
    }
    renderListItems();

    let currentIdx = -1;
    let statSeq = 0;
    const statCache = new Map<string, string>();
    const graphCache = new Map<string, string>();

    function cachedGraph(short: string): string {
        const hit = graphCache.get(short);
        if (hit !== undefined) return hit;
        const out = renderGraph(graphRaw, short);
        graphCache.set(short, out);
        if (graphCache.size > 200) {
            const firstKey = graphCache.keys().next().value;
            if (firstKey !== undefined) graphCache.delete(firstKey);
        }

        return out;
    }

    async function selectIndex(i: number): Promise<void> {
        if (i < 0 || i >= displayed.length || i === currentIdx) return;
        currentIdx = i;
        if (i >= displayed.length - 20) growWindow();
        const c = displayed[i];
        details.setContent(renderDetails(c));
        details.setScrollPerc(0);
        graph.setContent(cachedGraph(c.shortHash));

        const cached = statCache.get(c.hash);
        if (cached !== undefined) {
            stat.setContent(cached);
            stat.setScrollPerc(0);
            screen.render();

            return;
        }
        stat.setContent('{gray-fg}Loading…{/gray-fg}');
        screen.render();

        const seq = ++statSeq;
        const out = await loadStat(c.hash);
        const formatted = escape(out);
        statCache.set(c.hash, formatted);
        if (seq !== statSeq) return;
        stat.setContent(formatted);
        stat.setScrollPerc(0);
        screen.render();
    }

    let selectTimer: NodeJS.Timeout | null = null;
    list.on('select item', (_item, index) => {
        if (selectTimer) clearTimeout(selectTimer);
        selectTimer = setTimeout(() => {
            selectTimer = null;
            void selectIndex(index);
        }, 60);
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
        list.focus();
    });
    searchBox.key(['escape'], () => {
        searchBox.clearValue();
        if (filterQuery) {
            filterQuery = '';
            applyFilter();
        }
        list.focus();
    });
    list.key(['s', '/'], () => {
        searchBox.focus();
        searchBox.readInput();
    });

    function copyHash(c: Commit): void {
        const platform = process.platform;
        let cmd: string | null = null;
        let args: string[] = [];
        if (platform === 'darwin') {
            cmd = 'pbcopy';
        } else if (process.env.WAYLAND_DISPLAY) {
            cmd = 'wl-copy';
        } else if (process.env.DISPLAY) {
            cmd = 'xclip';
            args = ['-selection', 'clipboard'];
        }
        if (!cmd) return;
        try {
            const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
            p.stdin.write(c.hash);
            p.stdin.end();
        } catch { /* ignore */ }
    }

    function flashHeader(suffix: string): void {
        const prev = header.getContent();
        header.setContent(prev + ` {green-fg}${suffix}{/green-fg}`);
        screen.render();
        setTimeout(() => {
            header.setContent(prev);
            screen.render();
        }, 1200).unref();
    }

    async function showFullDiff(c: Commit): Promise<void> {
        await runInherit('sh', ['-c', `git show --color=always ${c.hash} | less -R`], screen);
    }

    async function browseCommitFiles(c: Commit): Promise<void> {
        const files = await loadCommitFiles(c.hash);
        if (files.length === 0) {
            flashHeader('no files in commit');

            return;
        }
        await browseFiles(screen, {
            title: `${c.shortHash} files`,
            files,
            view: async (file) => viewCommitFileDiff(screen, c, file),
        });
    }

    function jump(delta: number): void {
        if (displayed.length === 0) return;
        const cur = (list as unknown as { selected: number }).selected || 0;
        let target = cur + delta;
        if (Math.abs(delta) === 1) {
            if (target < 0) {
                ensureWindowAtLeast(filtered.length);
                target = filtered.length - 1;
            } else if (target >= filtered.length) {
                target = 0;
            }
        } else {
            if (target < 0) target = 0;
            if (target >= filtered.length) target = filtered.length - 1;
        }
        ensureWindowAtLeast(target + 21);
        target = Math.min(target, displayed.length - 1);
        list.select(target);
        screen.render();
    }

    attachVerticalNavigation(list, {
        moveBy: jump,
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
        submit: () => {
            if (displayed.length === 0) return;
            const c = displayed[currentIdx >= 0 ? currentIdx : 0];
            void browseCommitFiles(c);
        },
        cancel: () => {
            try { screen.destroy(); } catch { /* noop */ }
        },
    });

    list.key(['y'], () => {
        if (displayed.length === 0) return;
        const c = displayed[currentIdx >= 0 ? currentIdx : 0];
        copyHash(c);
        flashHeader(`✓ copied ${c.shortHash}`);
    });

    list.key(['d'], () => {
        if (displayed.length === 0) return;
        const c = displayed[currentIdx >= 0 ? currentIdx : 0];
        void showFullDiff(c);
    });

    attachFocusCycleKeys(screen, ring);

    screen.on('resize', () => {
        rebuildDisplayed();
        screen.render();
    });

    ring.focusAt(0);
    screen.render();

    let pendingRefresh: NodeJS.Timeout | null = null;
    function scheduleRefresh(): void {
        if (pendingRefresh) return;
        pendingRefresh = setTimeout(() => {
            pendingRefresh = null;
            setHeader();
            const wasEmpty = filtered.length === 0;
            if (!filterQuery) {
                filtered = commits.slice();
                if (displayed.length < Math.min(windowEnd, filtered.length)) {
                    rebuildDisplayed();
                }
            } else {
                applyFilter();
            }
            if (wasEmpty && currentIdx < 0 && displayed.length > 0) {
                list.select(0);
                void selectIndex(0);
            }
            screen.render();
        }, 200);
    }

    void streamCommits((added, _total) => {
        for (const c of added) commits.push(c);
        scheduleRefresh();
    }).then(() => {
        loading = false;
        if (pendingRefresh) {
            clearTimeout(pendingRefresh);
            pendingRefresh = null;
        }
        setHeader();
        if (!filterQuery) {
            filtered = commits.slice();
            rebuildDisplayed();
        } else {
            applyFilter();
        }
        if (currentIdx < 0 && displayed.length > 0) {
            list.select(0);
            void selectIndex(0);
        }
        screen.render();
    }).catch((e: Error) => {
        loading = false;
        setHeader();
        details.setContent(`{red-fg}Failed to load commits:{/red-fg} ${escape(e.message)}`);
        screen.render();
    });


    await awaitScreenDestroy(screen);
}
