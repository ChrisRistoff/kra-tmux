import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Dirent } from 'fs';
import * as bash from '@/utils/bashHelper';
import {
    attachFocusCycleKeys,
    attachVerticalNavigation,
    awaitScreenDestroy,
    createDashboardScreen,
    createDashboardShell,
    escTag,
} from '@/UI/dashboard';
import { browseFiles, runInherit } from '@/UI/dashboard/screen';
import type * as blessed from 'blessed';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RepoInfo {
    fullPath: string;
    relativePath: string;
    name: string;
    branch: string;
    isDirty: boolean;
    ahead: number;
    behind: number;
    lastCommitHash: string;
    lastCommitDate: string;
    lastCommitSubject: string;
    modifiedCount: number;
    untrackedCount: number;
    stashCount: number;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function findWorkspaceRoot(): Promise<string> {
    try {
        const { stdout } = await bash.execCommand('git rev-parse --show-toplevel');
        return path.dirname(stdout.trim());
    } catch {
        return process.cwd();
    }
}

async function scanForGitRepos(root: string, maxDepth = 2): Promise<RepoInfo[]> {
    const found: RepoInfo[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const childPath = path.join(dir, entry.name);
            const gitPath = path.join(childPath, '.git');
            let isRepo = false;
            try {
                const stat = await fs.stat(gitPath);
                isRepo = stat.isDirectory() || stat.isFile();
            } catch { /* not a repo */ }
            if (isRepo) {
                found.push(await collectRepoInfo(childPath, root));
            } else {
                await walk(childPath, depth + 1);
            }
        }
    }

    await walk(root, 0);

    // dirty repos first, then alphabetical
    return found.sort((a, b) => {
        if (a.isDirty && !b.isDirty) return -1;
        if (!a.isDirty && b.isDirty) return 1;
        return a.name.localeCompare(b.name);
    });
}

async function collectRepoInfo(repoPath: string, root: string): Promise<RepoInfo> {
    const c = (cmd: string) => bash.execCommand(cmd).catch(() => ({ stdout: '' }));
    const q = JSON.stringify(repoPath);

    const [branch, status, aheadBehind, commitInfo, stash] = await Promise.all([
        c(`git -C ${q} rev-parse --abbrev-ref HEAD`),
        c(`git -C ${q} status --porcelain`),
        c(`git -C ${q} rev-list --left-right --count HEAD...@{upstream}`),
        c(`git -C ${q} log -1 --format="%h|%ar|%s"`),
        c(`git -C ${q} stash list --format="%H"`),
    ]);

    const branchName = branch.stdout.trim() || '(detached HEAD)';
    const allStatusLines = status.stdout.trim().split('\n').filter(Boolean);
    const modifiedCount = allStatusLines.filter((l) => !l.startsWith('??')).length;
    const untrackedCount = allStatusLines.filter((l) => l.startsWith('??')).length;
    const isDirty = allStatusLines.length > 0;
    const stashCount = stash.stdout.trim().split('\n').filter(Boolean).length;

    let ahead = 0;
    let behind = 0;
    const ab = aheadBehind.stdout.trim();
    if (ab) {
        const parts = ab.split(/\s+/);
        ahead = parseInt(parts[0] ?? '0', 10) || 0;
        behind = parseInt(parts[1] ?? '0', 10) || 0;
    }

    let lastCommitHash = '';
    let lastCommitDate = '';
    let lastCommitSubject = '';
    const co = commitInfo.stdout.trim();
    if (co) {
        const parts = co.split('|');
        lastCommitHash = parts[0] ?? '';
        lastCommitDate = parts[1] ?? '';
        lastCommitSubject = parts.slice(2).join('|');
    }

    return {
        fullPath: repoPath,
        relativePath: path.relative(root, repoPath) || '.',
        name: path.basename(repoPath),
        branch: branchName,
        isDirty,
        ahead,
        behind,
        lastCommitHash,
        lastCommitDate,
        lastCommitSubject,
        modifiedCount,
        untrackedCount,
        stashCount,
    };
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function trunc(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}

function renderRepoRow(r: RepoInfo): string {
    const icon = r.isDirty ? '{yellow-fg}◉{/yellow-fg}' : '{green-fg}●{/green-fg}';
    const name = `{bold}${escTag(trunc(r.name, 24))}{/bold}`;
    const branch = `{gray-fg}${escTag(trunc(r.branch, 22))}{/gray-fg}`;
    const dirty = r.isDirty
        ? ` {yellow-fg}[${r.modifiedCount}M ${r.untrackedCount}U]{/yellow-fg}`
        : ' {green-fg}✓{/green-fg}';
    const sync = r.ahead > 0 || r.behind > 0
        ? ` {cyan-fg}↑${r.ahead}↓${r.behind}{/cyan-fg}`
        : '';
    const stash = r.stashCount > 0 ? ` {magenta-fg}⚑${r.stashCount}{/magenta-fg}` : '';
    return `${icon} ${name} ${branch}${dirty}${sync}${stash}`;
}

function renderRepoDetails(r: RepoInfo): string {
    const syncLine = r.ahead > 0 || r.behind > 0
        ? `  remote:     {cyan-fg}↑${r.ahead}{/cyan-fg} ahead  {cyan-fg}↓${r.behind}{/cyan-fg} behind`
        : '  remote:     {gray-fg}up to date{/gray-fg}';
    const stashLine = r.stashCount > 0
        ? `  stashes:    {magenta-fg}${r.stashCount}{/magenta-fg}`
        : '';

    return [
        `{cyan-fg}name{/cyan-fg}       {bold}${escTag(r.name)}{/bold}`,
        `{cyan-fg}path{/cyan-fg}       {white-fg}${escTag(r.fullPath)}{/white-fg}`,
        `{cyan-fg}branch{/cyan-fg}     {white-fg}${escTag(r.branch)}{/white-fg}`,
        '',
        `{cyan-fg}status{/cyan-fg}`,
        `  workspace:  ${r.isDirty ? '{yellow-fg}dirty{/yellow-fg}' : '{green-fg}clean{/green-fg}'}`,
        `  modified:   {yellow-fg}${r.modifiedCount}{/yellow-fg}`,
        `  untracked:  {magenta-fg}${r.untrackedCount}{/magenta-fg}`,
        syncLine,
        ...(stashLine ? [stashLine] : []),
        '',
        `{cyan-fg}last commit{/cyan-fg}`,
        `  {yellow-fg}${escTag(r.lastCommitHash || '—')}{/yellow-fg}  {gray-fg}${escTag(r.lastCommitDate || '')}{/gray-fg}`,
        `  ${escTag(r.lastCommitSubject || '(no commits)')}`,
    ].join('\n');
}

async function loadRecentLog(r: RepoInfo): Promise<string> {
    try {
        const { stdout } = await bash.execCommand(
            `git -C ${JSON.stringify(r.fullPath)} log --oneline --decorate -20`,
        );
        if (!stdout.trim()) return '{gray-fg}(no commits){/gray-fg}';
        return stdout.trim().split('\n').map((line) => {
            const m = line.match(/^([a-f0-9]+)\s+(.*)$/);
            if (!m) return escTag(line);
            return `{yellow-fg}${m[1]}{/yellow-fg} ${escTag(m[2] ?? '')}`;
        }).join('\n');
    } catch (e) {
        return `{red-fg}Error:{/red-fg} ${escTag((e as Error).message)}`;
    }
}

async function loadGitStatus(r: RepoInfo): Promise<string> {
    try {
        const { stdout } = await bash.execCommand(
            `git -C ${JSON.stringify(r.fullPath)} status`,
        );
        return escTag(stdout.trim()) || '{gray-fg}(clean){/gray-fg}';
    } catch (e) {
        return `{red-fg}Error:{/red-fg} ${escTag((e as Error).message)}`;
    }
}

async function loadDirtyFiles(r: RepoInfo): Promise<string[]> {
    try {
        const { stdout } = await bash.execCommand(
            `git -C ${JSON.stringify(r.fullPath)} diff --name-only HEAD`,
        );
        return stdout.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

async function viewFileDiff(
    screen: blessed.Widgets.Screen,
    repoPath: string,
    file: string,
): Promise<void> {
    const q = JSON.stringify(repoPath);
    const fq = JSON.stringify(file);
    // Try fugitive: open file then split diff vs HEAD
    try {
        await runInherit(
            'sh',
            ['-c', `cd ${q} && nvim -c "Gedit ${fq}" -c "Gvdiffsplit HEAD"`],
            screen,
        );
        return;
    } catch { /* fall back */ }

    // Fallback: write diff to temp file and open read-only
    const tmp = path.join(os.tmpdir(), `kra-scout-${path.basename(file)}.diff`);
    try {
        const { stdout } = await bash.execCommand(
            `git -C ${q} diff HEAD -- ${fq}`,
        );
        await fs.writeFile(tmp, stdout || `(no diff for ${file})\n`);
        await runInherit('nvim', ['-R', '-c', 'set filetype=diff', tmp], screen);
    } finally {
        try { await fs.unlink(tmp); } catch { /* ignore */ }
    }
}

// ─── Main dashboard ──────────────────────────────────────────────────────────


export async function scout(): Promise<void> {
    const root = await findWorkspaceRoot();
    let allRepos = await scanForGitRepos(root);

    let filterQuery = '';
    let showDirtyOnly = false;
    let displayed: RepoInfo[] = allRepos.slice();

    const screen = createDashboardScreen({ title: 'kra git scout' });

    const shell = createDashboardShell({
        screen,
        listLabel: 'repos',
        listFocusName: 'repos',
        listWidth: '45%',
        listItems: [],
        listTags: true,
        search: {
            label: 'filter',
            width: '45%',
            inputOnFocus: true,
            keys: false,
        },
        detailPanels: [
            { label: 'repo details', focusName: 'details' },
            { label: 'recent log', focusName: 'log' },
            { label: 'git status', focusName: 'status' },
        ],
        keymapText: () =>
            `{cyan-fg}j/k{/cyan-fg} nav   ` +
            `{cyan-fg}enter{/cyan-fg} nvim   ` +
            `{cyan-fg}l{/cyan-fg} git log   ` +
            `{cyan-fg}d{/cyan-fg} diff files   ` +
            `{cyan-fg}f{/cyan-fg} fetch   ` +
            `{cyan-fg}p{/cyan-fg} pull   ` +
            `{cyan-fg}D{/cyan-fg} dirty filter   ` +
            `{cyan-fg}r{/cyan-fg} refresh   ` +
            `{cyan-fg}s{/cyan-fg}/{cyan-fg}/{/cyan-fg} search   ` +
            `{cyan-fg}y{/cyan-fg} copy path   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
    });

    const { header, list, ring } = shell;
    const searchBox = shell.searchBox;
    const [details, logPanel, statusPanel] = shell.detailPanels;

    // ── Header ──────────────────────────────────────────────────────────────

    function setHeader(): void {
        const dirtyCount = allRepos.filter((r) => r.isDirty).length;
        const syncCount = allRepos.filter((r) => r.ahead > 0 || r.behind > 0).length;
        const filterTag = showDirtyOnly ? '  {yellow-fg}[dirty only]{/yellow-fg}' : '';
        header.setContent(
            ` {magenta-fg}{bold}◆ git scout{/bold}{/magenta-fg}` +
            `   {cyan-fg}root{/cyan-fg} {white-fg}${escTag(root)}{/white-fg}` +
            `   {cyan-fg}repos{/cyan-fg} {yellow-fg}${allRepos.length}{/yellow-fg}` +
            `   {cyan-fg}dirty{/cyan-fg} {yellow-fg}${dirtyCount}{/yellow-fg}` +
            `   {cyan-fg}out of sync{/cyan-fg} {cyan-fg}${syncCount}{/cyan-fg}` +
            filterTag,
        );
    }

    setHeader();

    // ── Filter / display ─────────────────────────────────────────────────────

    function applyFilter(): void {
        const q = filterQuery.trim().toLowerCase();
        let base = allRepos;
        if (showDirtyOnly) base = base.filter((r) => r.isDirty);
        if (q) {
            base = base.filter((r) =>
                r.name.toLowerCase().includes(q) ||
                r.relativePath.toLowerCase().includes(q) ||
                r.branch.toLowerCase().includes(q),
            );
        }
        displayed = base;
        renderListItems();
        if (displayed.length > 0) {
            list.select(0);
            void selectIndex(0);
        } else {
            details.setContent('{gray-fg}no matches{/gray-fg}');
            logPanel.setContent('');
            statusPanel.setContent('');
        }
        screen.render();
    }

    function renderListItems(): void {
        list.setItems(displayed.map((r) => renderRepoRow(r)));
    }

    // ── Selection / preview ──────────────────────────────────────────────────

    let currentIdx = -1;
    let loadSeq = 0;
    const logCache = new Map<string, string>();
    const statusCache = new Map<string, string>();

    async function selectIndex(i: number): Promise<void> {
        if (i < 0 || i >= displayed.length) return;
        currentIdx = i;
        const r = displayed[i];

        details.setContent(renderRepoDetails(r));
        details.setScrollPerc(0);

        // Load log panel
        const cachedLog = logCache.get(r.fullPath);
        if (cachedLog !== undefined) {
            logPanel.setContent(cachedLog);
            logPanel.setScrollPerc(0);
        } else {
            logPanel.setContent('{gray-fg}Loading…{/gray-fg}');
        }

        // Load status panel
        const cachedStatus = statusCache.get(r.fullPath);
        if (cachedStatus !== undefined) {
            statusPanel.setContent(cachedStatus);
            statusPanel.setScrollPerc(0);
        } else {
            statusPanel.setContent('{gray-fg}Loading…{/gray-fg}');
        }

        screen.render();

        // Fetch any missing panels in parallel
        const seq = ++loadSeq;
        const promises: Promise<void>[] = [];

        if (cachedLog === undefined) {
            promises.push(
                loadRecentLog(r).then((out) => {
                    if (seq !== loadSeq) return;
                    logCache.set(r.fullPath, out);
                    logPanel.setContent(out);
                    logPanel.setScrollPerc(0);
                    screen.render();
                }),
            );
        }

        if (cachedStatus === undefined) {
            promises.push(
                loadGitStatus(r).then((out) => {
                    if (seq !== loadSeq) return;
                    statusCache.set(r.fullPath, out);
                    statusPanel.setContent(out);
                    statusPanel.setScrollPerc(0);
                    screen.render();
                }),
            );
        }

        if (promises.length > 0) await Promise.all(promises);
    }

    renderListItems();
    if (displayed.length > 0) {
        list.select(0);
        void selectIndex(0);
    }

    let selectTimer: NodeJS.Timeout | null = null;
    list.on('select item', (_item: unknown, index: number) => {
        if (selectTimer) clearTimeout(selectTimer);
        selectTimer = setTimeout(() => {
            selectTimer = null;
            void selectIndex(index);
        }, 60);
    });

    // ── Search ───────────────────────────────────────────────────────────────

    if (searchBox) {
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
        list.key(['s', '/'], () => {
            searchBox.focus();
            searchBox.readInput();
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function selectedRepo(): RepoInfo | undefined {
        return displayed[(list as unknown as { selected: number }).selected ?? currentIdx];
    }

    function flashHeader(msg: string, color = 'green'): void {
        const prev = header.getContent();
        header.setContent(prev + `  {${color}-fg}${escTag(msg)}{/${color}-fg}`);
        screen.render();
        setTimeout(() => { header.setContent(prev); screen.render(); }, 1800).unref();
    }

    function copyToClipboard(text: string): void {
        let cmd: string | null = null;
        let args: string[] = [];
        if (process.platform === 'darwin') { cmd = 'pbcopy'; }
        else if (process.env.WAYLAND_DISPLAY) { cmd = 'wl-copy'; }
        else if (process.env.DISPLAY) { cmd = 'xclip'; args = ['-selection', 'clipboard']; }
        if (!cmd) return;
        try {
            const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
            p.stdin.write(text);
            p.stdin.end();
        } catch { /* ignore */ }
    }

    async function refreshRepo(r: RepoInfo): Promise<void> {
        const updated = await collectRepoInfo(r.fullPath, root);
        const idx = allRepos.findIndex((x) => x.fullPath === r.fullPath);
        if (idx >= 0) allRepos[idx] = updated;
        logCache.delete(r.fullPath);
        statusCache.delete(r.fullPath);
    }

    // ── Key bindings ─────────────────────────────────────────────────────────

    // enter → open nvim in repo
    list.key(['enter'], async () => {
        const r = selectedRepo();
        if (!r) return;
        await runInherit('sh', ['-c', `cd ${JSON.stringify(r.fullPath)} && nvim .`], screen);
    });

    // d → browse dirty files one by one with diff split view
    list.key(['d'], async () => {
        const r = selectedRepo();
        if (!r) return;
        const files = await loadDirtyFiles(r);
        if (files.length === 0) {
            flashHeader(`${r.name} has no changes vs HEAD`);
            return;
        }
        await browseFiles(screen, {
            title: `${r.name} — changed files`,
            files,
            view: async (file) => {
                await viewFileDiff(screen, r.fullPath, file);
            },
        });
        // Refresh after editing
        await refreshRepo(r);
        applyFilter();
        setHeader();
    });

    // f → fetch
    list.key(['f'], async () => {
        const r = selectedRepo();
        if (!r) return;
        flashHeader(`fetching ${r.name}…`, 'yellow');
        try {
            await bash.execCommand(`git -C ${JSON.stringify(r.fullPath)} fetch --prune`);
            await refreshRepo(r);
            applyFilter();
            setHeader();
            flashHeader(`✓ fetched ${r.name}`);
        } catch (e) {
            flashHeader(`✗ fetch failed: ${(e as Error).message}`, 'red');
        }
    });

    // p → pull (ff-only, shown in pager for output)
    list.key(['p'], async () => {
        const r = selectedRepo();
        if (!r) return;
        await runInherit('sh', ['-c', `git -C ${JSON.stringify(r.fullPath)} pull --ff-only`], screen);
        await refreshRepo(r);
        applyFilter();
        setHeader();
    });

    // D → toggle dirty-only filter
    list.key(['D', 'S-d'], () => {
        showDirtyOnly = !showDirtyOnly;
        setHeader();
        applyFilter();
    });

    // r → rescan workspace
    list.key(['r'], async () => {
        flashHeader('rescanning…', 'yellow');
        allRepos = await scanForGitRepos(root);
        logCache.clear();
        statusCache.clear();
        setHeader();
        applyFilter();
        flashHeader('✓ rescanned');
    });

    // y → copy full path to clipboard
    list.key(['y'], () => {
        const r = selectedRepo();
        if (!r) return;
        copyToClipboard(r.fullPath);
        flashHeader(`✓ copied ${r.relativePath}`);
    });

    // l → open git log dashboard for selected repo
    list.key(['l'], async () => {
        const r = selectedRepo();
        if (!r) return;
        const binPath = path.resolve(__dirname, '../../../../bin/kra.js');
        await runInherit(
            'sh',
            ['-c', `cd ${JSON.stringify(r.fullPath)} && node ${JSON.stringify(binPath)} git log`],
            screen,
        );
    });

    // vertical navigation with wrap-around
    attachVerticalNavigation(list, {
        moveBy: (delta: number) => {
            if (displayed.length === 0) return;
            const sel = list as unknown as { selected: number };
            let target = (sel.selected || 0) + delta;
            if (target < 0) target = displayed.length - 1;
            if (target >= displayed.length) target = 0;
            list.select(target);
            screen.render();
        },
        top: () => { list.select(0); screen.render(); },
        bottom: () => { list.select(displayed.length - 1); screen.render(); },
    });

    attachFocusCycleKeys(screen, ring);
    list.key(['q', 'escape'], () => screen.destroy());
    screen.key(['q', 'C-c'], () => screen.destroy());

    list.focus();
    ring.renderFooter();
    screen.render();
    await awaitScreenDestroy(screen);
}
