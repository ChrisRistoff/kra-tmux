import * as blessed from 'blessed';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as bash from '@/utils/bashHelper';
import { GIT_COMMANDS } from '@/git/config/gitConstants';
import {
    type ListDetailDashboardApi,
    createListDetailDashboard,
    modalConfirm,
    pickList,
    theme,
} from '@/UI/dashboard';
import { browseFiles, runInherit } from '@/UI/dashboard/screen';
import { interactiveCherryPick } from '@/git/commands/cherryPickFlow';

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
    gitArgs: string[],
    fmt: string,
    onChunk: (added: Commit[], total: number) => void,
): Promise<Commit[]> {
    const all: Commit[] = [];
    let buffer = '';

    return new Promise((resolve, reject) => {
        const p = spawn('git', [...gitArgs, `--pretty=format:${fmt}${RECORD_SEP}`], {
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
                reject(new Error(`git ${gitArgs[0] ?? 'log'} exited with code ${code ?? 'null'}`));

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

async function findContainingRef(short: string): Promise<string | null> {
    try {
        const { stdout } = await bash.execCommand(
            `git for-each-ref --contains=${short} --sort=-committerdate --count=1 --format='%(refname:short)' refs/heads/ refs/remotes/`,
        );
        const first = stdout.split('\n').find((s) => s.trim().length > 0);

        return first ? first.trim() : null;
    } catch {
        return null;
    }
}

async function findDescendant(short: string, tip: string, distance: number): Promise<string | null> {
    if (tip === short) return null;
    try {
        const { stdout } = await bash.execCommand(
            `git rev-list --reverse --ancestry-path ${short}..${tip} | head -n ${distance} | tail -n 1`,
        );
        const sha = stdout.trim();

        return sha.length > 0 ? sha : null;
    } catch {
        return null;
    }
}

async function loadGraphAround(
    gitArgs: string[],
    short: string,
    radius = 30,
): Promise<string> {
    const span = radius * 2;
    const stripped = gitArgs.filter((a) => a !== '--all' && a !== '--branches' && a !== '--remotes');
    const containing = (await findContainingRef(short)) ?? short;
    const descendant = await findDescendant(short, containing, radius);

    if (descendant) {
        const range = `${short}~${radius}..${descendant}`;
        try {
            const { stdout } = await bash.execCommand(
                `git ${stripped.join(' ')} --graph --decorate --topo-order --format='%h\x1f%d\x1f%s\x1f%an\x1f%ar' -n ${span} ${range}`,
            );
            if (stdout.trim().length > 0 && stdout.includes(short)) return stdout;
        } catch { /* fall through */ }
    }

    try {
        const { stdout } = await bash.execCommand(
            `git ${stripped.join(' ')} --graph --all --decorate --topo-order --format='%h\x1f%d\x1f%s\x1f%an\x1f%ar' -n ${span} ^${short}~${radius}`,
        );
        if (stdout.includes(short)) return stdout;
    } catch { /* fall through */ }

    try {
        const { stdout } = await bash.execCommand(
            `git ${stripped.join(' ')} --graph --decorate --topo-order --format='%h\x1f%d\x1f%s\x1f%an\x1f%ar' -n ${span} ${short}`,
        );

        return stdout;
    } catch (e) {
        return `Failed to load graph: ${(e as Error).message}`;
    }
}

async function loadAllBranches(): Promise<string[]> {
    try {
        const { stdout } = await bash.execCommand(
            `git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/ refs/remotes/`,
        );

        return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0 && !s.endsWith('/HEAD'));
    } catch {
        return [];
    }
}

function scopeArgs(base: string[], scope: string | null): string[] {
    const stripped = base.filter((a) => a !== '--all' && a !== '--branches' && a !== '--remotes');
    if (scope === null) return stripped;

    return [...stripped, scope];
}

function scopeGraphArgs(base: string[], scope: string | null): string[] {
    if (scope === null) {
        if (base.includes('--all') || base.includes('--branches') || base.includes('--remotes')) return base;

        return [...base, '--all'];
    }

    return scopeArgs(base, scope);
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
    const hash = theme.warn(c.shortHash);
    const refs = c.refs ? ` ${theme.success(`(${truncate(c.refs, 24)})`)}` : '';
    const date = theme.date(pad(c.relDate, 14));
    const subjMax = Math.max(10, width - 8 - 14 - (c.refs ? 26 : 0) - 4);
    const subject = theme.value(escape(truncate(c.subject, subjMax)));

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

function colorizeStat(s: string): string {
    return s.split('\n').map((line) => {
        const summary = line.match(/^(\s*)(\d+ files? changed)(.*)$/);
        if (summary) {
            const rest = summary[3]
                .replace(/(\d+) insertions?\(\+\)/g, (_m, n) => `${theme.success(n + ' insertions(+)')}`)
                .replace(/(\d+) deletions?\(-\)/g, (_m, n) => `${theme.err(n + ' deletions(-)')}`);

            return `${summary[1]}${theme.label(summary[2])}${rest}`;
        }
        const fileLine = line.match(/^(\s*)(\S.*?)(\s*\|\s*)(\d+|Bin[^+\-]*)(\s*)([+\-]*)\s*$/);
        if (fileLine) {
            const [, lead, file, sep, count, gap, bar] = fileLine;
            const coloredBar = bar.replace(/[+\-]/g, (c) => c === '+' ? theme.success('+') : theme.err('-'));

            return `${lead}${theme.path(file)}${theme.dim(sep)}${theme.count(count)}${gap}${coloredBar}`;
        }

        return line;
    }).join('\n');
}

function renderDetails(c: Commit): string {
    const refs = c.refs ? theme.success(escape(c.refs)) : theme.dim('(no refs)');
    const lines = [
        `${theme.warn('{bold}commit{/bold}')} ${theme.warn(c.hash)}`,
        `${theme.label('author')}  ${theme.success(escape(c.author))} ${theme.dim(`<${escape(c.email)}>`)}`,
        `${theme.label('date')}    ${theme.date(escape(c.isoDate))}  ${theme.dim(`(${escape(c.relDate)})`)}`,
        `${theme.label('refs')}    ${refs}`,
        '',
        `{bold}${theme.value(escape(c.subject))}{/bold}`,
    ];
    if (c.body) {
        lines.push('');
        lines.push(escape(c.body));
    }

    return lines.join('\n');
}

function renderGraph(raw: string, currentShort: string): { content: string; matchLine: number } {
    if (!raw.trim()) return { content: theme.dim('(empty graph)'), matchLine: -1 };
    const railSwap = (s: string): string =>
        s
            .replace(/\*/g, '\u0001')
            .replace(/\|/g, '│')
            .replace(/\//g, '╱')
            .replace(/\\/g, '╲')
            .replace(/_/g, '─')
            .replace(/\u0001/g, '●');
    const railPalette = ['cyan', 'yellow', 'green', 'blue', 'red', 'white', 'magenta'];
    const colorRails = (s: string): string => {
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '●') {
                out += '{magenta-fg}{bold}●{/bold}{/magenta-fg}';
            } else if (c === '│' || c === '╱' || c === '╲' || c === '─') {
                const color = railPalette[Math.floor(i / 2) % railPalette.length];
                out += `{${color}-fg}${c}{/${color}-fg}`;
            } else {
                out += escape(c);
            }
        }

        return out;
    };

    let matchLine = -1;
    const rendered = raw
        .split('\n')
        .map((line, idx) => {
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
            const hashOut = theme.warn(`{bold}${escape(hash)}{/bold}`);
            const refsOut = refsRaw
                ? ` ${theme.success(escape(refsRaw))}`
                : '';
            const subjOut = ` ${theme.value(escape(truncate(subject, 80)))}`;
            const metaOut = author
                ? ` ${theme.dim(`· ${escape(author)}, ${escape(age)}`)}`
                : '';
            const content = `${hashOut}${refsOut}${subjOut}${metaOut}`;

            if (currentShort && hash === currentShort) {
                if (matchLine < 0) matchLine = idx;
                const stripped = `${hash}${refsRaw ? ' ' + refsRaw : ''} ${truncate(subject, 80)}${author ? ' · ' + author + ', ' + age : ''}`;

                return `${railsOut}${theme.hl(escape(stripped))}`;
            }

            return `${railsOut}${content}`;
        })
        .join('\n');

    return { content: rendered, matchLine };
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

export interface GitLogDashboardOptions {
    title?: string;
    listLabel?: string;
    logArgs?: string[];
    graphArgs?: string[];
    fmtFields?: string[];
}

const DEFAULT_FMT_FIELDS = ['%H', '%h', '%an', '%ae', '%ar', '%aI', '%D', '%s', '%b'];

export async function gitLogDashboard(opts: GitLogDashboardOptions = {}): Promise<void> {
    const logArgs = opts.logArgs ?? ['log'];
    const graphArgs = opts.graphArgs ?? ['log', '--all'];
    const fmt = (opts.fmtFields ?? DEFAULT_FMT_FIELDS).join(FIELD_SEP);
    const listLabel = opts.listLabel ?? 'commits';
    const [branch, topLevel] = await Promise.all([
        bash.execCommand(GIT_COMMANDS.GET_BRANCH).then((r) => r.stdout.trim()),
        bash.execCommand(GIT_COMMANDS.GET_TOP_LEVEL).then((r) => r.stdout.trim()),
    ]);

    const commits: Commit[] = [];
    let loading = true;
    const statCache = new Map<string, string>();
    const graphCache = new Map<string, { content: string; matchLine: number }>();
    const graphPending = new Map<string, Promise<{ content: string; matchLine: number }>>();
    const statPending = new Map<string, Promise<string>>();

    const cherryReq: { value: { hash: string; shortHash: string } | null } = { value: null };
    const pickFlag = { value: false };
    let nextScope: { value: string | null } | null = null;

    let api: ListDetailDashboardApi<Commit> | null = null;

    function headerContent(): string {
        const head: Commit | undefined = commits.length > 0 ? commits[0] : undefined;
        const headPart = head
            ? `   ${theme.label('HEAD')} ${theme.warn(head.shortHash)} ${theme.dim(escape(truncate(head.subject, 40)))}`
            : '';
        const loadingPart = loading
            ? `   ${theme.warn('\u25dc loading\u2026')}`
            : '';

        return ` ${theme.title('\u25c6 git log')}` +
            `   ${theme.label('branch')} ${theme.warn(escape(branch))}` +
            `   ${theme.label('repo')} ${theme.path(escape(topLevel))}` +
            `   ${theme.label('commits')} ${theme.count(commits.length)}` +
            headPart +
            loadingPart;
    }

    async function loadGraphFor(short: string): Promise<{ content: string; matchLine: number }> {
        const existing = graphPending.get(short);
        if (existing) return existing;
        const p = loadGraphAround(graphArgs, short).then((raw) => {
            const out = renderGraph(raw, short);
            graphCache.set(short, out);
            if (graphCache.size > 200) {
                const firstKey = graphCache.keys().next().value;
                if (firstKey !== undefined) graphCache.delete(firstKey);
            }
            graphPending.delete(short);

            return out;
        }).catch((e: Error) => {
            graphPending.delete(short);

            return { content: `${theme.err('Failed to load graph:')} ${escape(e.message)}`, matchLine: -1 };
        });
        graphPending.set(short, p);

        return p;
    }

    function centerGraphOn(graphPanel: blessed.Widgets.BoxElement, matchLine: number): void {
        if (matchLine < 0) {
            graphPanel.setScroll(0);

            return;
        }
        const g = graphPanel as unknown as { _clines?: { ftor?: number[][] }; iheight?: number };
        const displayRow = g._clines?.ftor?.[matchLine]?.[0] ?? matchLine;
        const boxHeight = typeof graphPanel.height === 'number' ? graphPanel.height : 0;
        const visible = Math.max(1, boxHeight - (g.iheight ?? 2));
        graphPanel.setScroll(Math.max(0, displayRow - Math.floor(visible / 2)));
    }

    async function loadStatFor(hash: string): Promise<string> {
        const existing = statPending.get(hash);
        if (existing) return existing;
        const p = loadStat(hash).then((out) => {
            const formatted = colorizeStat(escape(out));
            statCache.set(hash, formatted);
            statPending.delete(hash);

            return formatted;
        }).catch((e: Error) => {
            statPending.delete(hash);

            return `${theme.err('Failed:')} ${escape(e.message)}`;
        });
        statPending.set(hash, p);

        return p;
    }

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

    async function showFullDiff(c: Commit, screen: blessed.Widgets.Screen): Promise<void> {
        await runInherit('sh', ['-c', `git show --color=always ${c.hash} | less -R`], screen);
    }

    async function browseCommitFiles(c: Commit, screen: blessed.Widgets.Screen, a: ListDetailDashboardApi<Commit>): Promise<void> {
        const files = await loadCommitFiles(c.hash);
        if (files.length === 0) {
            a.flashHeader(` ${theme.success('no files in commit')}`);

            return;
        }
        await browseFiles(screen, {
            title: `${c.shortHash} files`,
            files,
            view: async (file) => viewCommitFileDiff(screen, c, file),
        });
    }

    async function isCherryPickInProgress(): Promise<boolean> {
        try {
            const { stdout } = await bash.execCommand('git rev-parse --git-dir');
            const gitDir = stdout.trim();
            const { stdout: head } = await bash.execCommand(`test -f ${gitDir}/CHERRY_PICK_HEAD && echo yes || echo no`);

            return head.trim() === 'yes';
        } catch {
            return false;
        }
    }

    async function abortCherryPick(a: ListDetailDashboardApi<Commit>): Promise<void> {
        if (!(await isCherryPickInProgress())) {
            a.flashHeader(` ${theme.success('no cherry-pick in progress')}`);

            return;
        }
        const ok = await modalConfirm(a.screen, 'Abort cherry-pick', 'Abort the in-progress cherry-pick and restore HEAD?');
        if (!ok) return;
        try {
            await bash.execCommand('git cherry-pick --abort');
            a.flashHeader(` ${theme.success('\u2713 cherry-pick aborted')}`);
        } catch (e) {
            a.flashHeader(` ${theme.err(`\u2717 abort failed: ${(e as Error).message.split('\n')[0]}`)}`);
        }
    }

    let pendingRefresh: NodeJS.Timeout | null = null;
    function scheduleRefresh(): void {
        if (!api || pendingRefresh) return;
        pendingRefresh = setTimeout(() => {
            pendingRefresh = null;
            const a = api;
            if (!a) return;
            const cur = a.selectedRow();
            a.setRows(commits.slice(), { preserveKey: cur ? cur.hash : null });
            a.refreshHeader();
        }, 200);
        pendingRefresh.unref();
    }

    void streamCommits(logArgs, fmt, (added, _total) => {
        for (const c of added) commits.push(c);
        scheduleRefresh();
    }).then(() => {
        loading = false;
        if (pendingRefresh) {
            clearTimeout(pendingRefresh);
            pendingRefresh = null;
        }
        if (api) {
            const cur = api.selectedRow();
            api.setRows(commits.slice(), { preserveKey: cur ? cur.hash : null });
            api.refreshHeader();
        }
    }).catch((e: Error) => {
        loading = false;
        if (api) {
            api.refreshHeader();
            api.flashHeader(` ${theme.err(`Failed to load commits: ${escape(e.message)}`)}`, 4000);
        }
    });

    await createListDetailDashboard<Commit>({
        title: opts.title ?? `git log \u00b7 ${branch}`,
        headerContent,
        listLabel,
        listFocusName: listLabel,
        listWidth: '40%',
        listTags: true,
        keymapText: () =>
            `${theme.key('j/k')} nav   ${theme.key('[ ]')} \u00b110   ${theme.key('{ }')} \u00b1100   ` +
            `${theme.key('enter')} files in commit   ` +
            `${theme.key('d')} full diff   ` +
            `${theme.key('c')} cherry-pick   ` +
            `${theme.key('A')} abort cherry-pick   ` +
            `${theme.key('B')} scope branch   ` +
            `${theme.key('s')} / ${theme.key('/')} search   ` +
            `${theme.key('y')} yank hash   ` +
            `${theme.key('q')} quit`,
        initialRows: [],
        rowKey: (c) => c.hash,
        renderListItem: (c, _i, _sel) => {
            const w = (api?.shell.list.width as number | undefined) ?? 40;

            return formatCommitRow(c, w - 4);
        },
        filter: {
            label: 'search',
            mode: 'live',
            match: (c, q) => {
                const lq = q.toLowerCase();

                return c.subject.toLowerCase().includes(lq)
                    || c.author.toLowerCase().includes(lq)
                    || c.hash.toLowerCase().includes(lq)
                    || c.shortHash.toLowerCase().includes(lq)
                    || c.relDate.toLowerCase().includes(lq);
            },
        },
        detailPanels: [
            {
                label: 'commit details',
                focusName: 'details',
                paint: (c) => renderDetails(c),
            },
            {
                label: 'files changed (this commit)',
                focusName: 'files',
                initialContent: theme.dim('Loading\u2026'),
                paint: (c, ctx) => {
                    const cached = statCache.get(c.hash);
                    if (cached !== undefined) return cached;
                    void loadStatFor(c.hash).then(() => {
                        if (ctx.isStale()) return;
                        ctx.api.repaintDetails();
                    });

                    return theme.dim('Loading\u2026');
                },
            },
            {
                label: 'branch graph',
                focusName: 'graph',
                wrap: false,
                paint: (c, ctx) => {
                    const cached = graphCache.get(c.shortHash);
                    if (cached !== undefined) {
                        setImmediate(() => {
                            const panel = ctx.api.shell.detailPanels[2];
                            if (panel) centerGraphOn(panel, cached.matchLine);
                        });

                        return cached.content;
                    }
                    void loadGraphFor(c.shortHash).then(() => {
                        if (ctx.isStale()) return;
                        ctx.api.repaintDetails();
                    });

                    return theme.dim('Loading graph\u2026');
                },
            },
        ],
        actions: [
            {
                keys: 'enter',
                handler: (c, a) => {
                    if (c === undefined) return;
                    void browseCommitFiles(c, a.screen, a);
                },
            },
            {
                keys: 'y',
                handler: (c, a) => {
                    if (c === undefined) return;
                    copyHash(c);
                    a.flashHeader(` ${theme.success(`\u2713 copied ${c.shortHash}`)}`);
                },
            },
            {
                keys: 'd',
                handler: (c, a) => {
                    if (c === undefined) return;
                    void showFullDiff(c, a.screen);
                },
            },
            {
                keys: 'c',
                handler: (c, a) => {
                    if (c === undefined) return;
                    cherryReq.value = { hash: c.hash, shortHash: c.shortHash };
                    a.destroy();
                },
            },
            {
                keys: ['A', 'S-a'],
                handler: (_c, a) => { void abortCherryPick(a); },
            },
            {
                keys: ['B', 'S-b'],
                handler: (_c, a) => {
                    pickFlag.value = true;
                    a.destroy();
                },
            },
        ],
        onReady: (a) => { api = a; a.refreshHeader(); },
    });

    if (pendingRefresh) {
        clearTimeout(pendingRefresh);
        pendingRefresh = null;
    }
    api = null;

    const baseLog = opts.logArgs ?? ['log'];
    const baseGraph = opts.graphArgs ?? ['log', '--all'];
    const baseTitle = opts.title ?? `git log \u00b7 ${branch}`;

    if (cherryReq.value !== null) {
        const req = cherryReq.value;
        const result = await interactiveCherryPick(req.hash, req.shortHash, branch);
        if (result.outcome !== 'applied') {
            console.log(`cherry-pick ${req.shortHash}: ${result.outcome} \u2014 ${result.message}`);
        }
        await gitLogDashboard({ ...opts });

        return;
    }

    if (pickFlag.value) {
        const branches = await loadAllBranches();
        const ALL = '<all branches>';
        const items = [ALL, ...branches];
        const result = await pickList({
            title: 'Scope log to branch',
            header: `Pick a branch to scope ${listLabel} \u00b7 ${branches.length} branch(es)`,
            items,
            itemsUseTags: true,
            renderItem: (item) => item === ALL
                ? theme.accent('<all branches>')
                : theme.label(item),
            showDetailsPanel: false,
        });
        if (result.value !== null) {
            nextScope = { value: result.value === ALL ? null : result.value };
        } else {
            await gitLogDashboard({ ...opts });

            return;
        }
    }

    const scopeReq = nextScope as { value: string | null } | null;
    if (scopeReq !== null) {
        const scope = scopeReq.value;
        await gitLogDashboard({
            ...opts,
            logArgs: scopeArgs(baseLog, scope),
            graphArgs: scopeGraphArgs(baseGraph, scope),
            title: scope === null ? baseTitle : `${baseTitle} \u2014 ${scope}`,
        });
    }
}
