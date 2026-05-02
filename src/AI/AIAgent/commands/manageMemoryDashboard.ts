import blessed from 'blessed';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import * as lancedb from '@lancedb/lancedb';
import {
    loadRegistry,
    removeRegistryEntry,
    upsertRegistryEntry,
    type RegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import { computeRepoKey } from '@/AI/AIAgent/shared/memory/repoKey';
import { kraMemoryRepoRoot } from '@/filePaths';
import {
    listMemories,
    deleteMemory,
    updateMemory,
    remember,
    editMemory,
} from '@/AI/AIAgent/shared/memory/notes';
import {
    MEMORY_KINDS,
    MEMORY_STATUSES,
    isRevisitKind,
    type MemoryStatus,
    type MemoryKind,
    type MemoryEntry,
} from '@/AI/AIAgent/shared/memory/types';
import {
    escTag,
    modalText,
    modalChoice,
    modalConfirm,
    createDashboardScreen,
    awaitScreenDestroy,
    createDashboardShell,
    attachVerticalNavigation,
    attachFocusCycleKeys,
    attachTreeExpandCollapseKeys,
    toggleExpandedRow,
} from '@/UI/dashboard';
import { inspectCurrentCodeIndex, runCurrentCodeIndex } from '@/AI/AIAgent/commands/indexCodebase';

interface RepoNode {
    kind: 'repo';
    id: string;
    entry: RegistryEntry;
}
interface MemoryNode {
    kind: 'memory';
    entry: MemoryEntry;
}
interface GroupNode {
    kind: 'group';
    id: 'repos' | 'findings' | 'revisits';
    label: string;
    children: (RepoNode | MemoryNode)[];
}
interface AddNode {
    kind: 'add';
    id: 'add';
    label: string;
}
type AnyNode = GroupNode | RepoNode | MemoryNode | AddNode;

interface TreeRow {
    id: string;
    depth: number;
    node: AnyNode;
    expandable: boolean;
    isOpen?: boolean;
}

interface DashState {
    repos: { id: string; entry: RegistryEntry }[];
    findings: MemoryEntry[];
    revisits: MemoryEntry[];
    repoFiles: Record<string, { path: string; chunks: number }[]>;
}


function shortDate(ts: number): string {
    if (!ts) return 'never';

    return new Date(ts).toISOString().slice(0, 10);
}

async function loadState(): Promise<DashState> {
    const reg = await loadRegistry();
    const repos = Object.keys(reg.repos)
        .map((id) => ({ id, entry: reg.repos[id] }))
        .sort((a, b) => a.entry.alias.localeCompare(b.entry.alias));
    const all = await listMemories({ scope: 'all', limit: 500 });
    const findings: MemoryEntry[] = [];
    const revisits: MemoryEntry[] = [];
    for (const m of all) {
        if (isRevisitKind(m.kind)) revisits.push(m);
        else findings.push(m);
    }
    const repoFiles: Record<string, { path: string; chunks: number }[]> = {};
    for (const r of repos) {
        repoFiles[r.id] = await loadRepoFiles(r.entry);
    }

    return { repos, findings, revisits, repoFiles };
}

async function loadRepoFiles(entry: { repoKey?: string; rootPath: string; id?: string }): Promise<{ path: string; chunks: number }[]> {
    const repoKey = entry.repoKey ?? (entry.id ? computeRepoKey(entry.id) : computeRepoKey(entry.rootPath));
    const lanceRoot = path.join(kraMemoryRepoRoot(repoKey), 'lance');
    try {
        const db = await lancedb.connect(lanceRoot);
        const names = await db.tableNames();
        if (!names.includes('code_chunks')) return [];
        const table = await db.openTable('code_chunks');
        const rows = await table.query().select(['path']).limit(50000).toArray();
        const counts = new Map<string, number>();
        for (const r of rows) {
            const p = String((r as { path?: unknown }).path ?? '');
            if (!p) continue;
            counts.set(p, (counts.get(p) ?? 0) + 1);
        }

        return Array.from(counts.entries())
            .map(([p, chunks]) => ({ path: p, chunks }))
            .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
        return [];
    }
}

function matchesFilter(node: RepoNode | MemoryNode, q: string): boolean {
    if (!q) return true;
    const needle = q.toLowerCase();
    if (node.kind === 'repo') {
        const e = node.entry;

        return e.alias.toLowerCase().includes(needle)
            || e.rootPath.toLowerCase().includes(needle);
    }
    const m = node.entry;

    return m.title.toLowerCase().includes(needle)
        || m.kind.toLowerCase().includes(needle)
        || m.body.toLowerCase().includes(needle)
        || m.tags.some((t) => t.toLowerCase().includes(needle));
}

function buildRows(state: DashState, expanded: Set<string>, filterQuery = ''): TreeRow[] {
    const rows: TreeRow[] = [];
    const filtering = filterQuery.trim().length > 0;
    const groups: GroupNode[] = [
        {
            kind: 'group',
            id: 'repos',
            label: `Indexed Repositories (${state.repos.length})`,
            children: state.repos.map((r) => ({ kind: 'repo' as const, id: r.id, entry: r.entry })),
        },
        {
            kind: 'group',
            id: 'findings',
            label: `Findings (${state.findings.length})`,
            children: state.findings.map((m) => ({ kind: 'memory' as const, entry: m })),
        },
        {
            kind: 'group',
            id: 'revisits',
            label: `Revisits (${state.revisits.length})`,
            children: state.revisits.map((m) => ({ kind: 'memory' as const, entry: m })),
        },
    ];
    for (const g of groups) {
        const gid = `g/${g.id}`;
        const filteredChildren = filtering
            ? g.children.filter((c) => matchesFilter(c, filterQuery))
            : g.children;
        if (filtering && filteredChildren.length === 0) continue;
        const open = filtering ? true : expanded.has(gid);
        const labelOverride = filtering
            ? { ...g, label: `${g.label.replace(/\(\d+\)$/, '')}(${filteredChildren.length}/${g.children.length})` }
            : g;
        rows.push({ id: gid, depth: 0, node: labelOverride, expandable: true, isOpen: open });
        if (open) {
            for (const c of filteredChildren) {
                if (c.kind === 'repo') {
                    rows.push({ id: `repo/${c.id}`, depth: 1, node: c, expandable: false });
                } else {
                    rows.push({ id: `mem/${c.entry.id}`, depth: 1, node: c, expandable: false });
                }
            }
        }
    }
    if (!filtering) {
        rows.push({
            id: 'add',
            depth: 0,
            node: { kind: 'add', id: 'add', label: '+ add new memory' },
            expandable: false,
        });
    }

    return rows;
}

function renderRow(row: TreeRow): string {
    const indent = '  '.repeat(row.depth);
    const n = row.node;
    if (n.kind === 'group') {
        const arrow = row.isOpen ? '▼' : '▶';

        return `${indent}{magenta-fg}${arrow}{/magenta-fg} {magenta-fg}{bold}${escTag(n.label)}{/bold}{/magenta-fg}`;
    }
    if (n.kind === 'repo') {
        const e = n.entry;

        return `${indent}{cyan-fg}❑{/cyan-fg} {white-fg}${escTag(e.alias)}{/white-fg} {gray-fg}· ${e.chunksCount} chunks{/gray-fg}`;
    }
    if (n.kind === 'memory') {
        const m = n.entry;
        const statusIcon = m.status === 'open'
            ? '{yellow-fg}○{/yellow-fg}'
            : m.status === 'resolved' ? '{green-fg}●{/green-fg}' : '{gray-fg}●{/gray-fg}';
        const kind = `{cyan-fg}[${escTag(m.kind)}]{/cyan-fg}`;
        const date = `{gray-fg}${shortDate(m.createdAt)}{/gray-fg}`;

        return `${indent}${statusIcon} ${kind} ${date} {white-fg}${escTag(m.title)}{/white-fg}`;
    }

    return `${indent}{green-fg}+{/green-fg} {green-fg}${escTag(n.label)}{/green-fg}`;
}

function renderDetails(row: TreeRow | undefined): string {
    if (!row) return '';
    const n = row.node;
    if (n.kind === 'group') {
        return `{magenta-fg}{bold}${escTag(n.label)}{/bold}{/magenta-fg}\n\n{gray-fg}${n.children.length} item${n.children.length === 1 ? '' : 's'}{/gray-fg}`;
    }
    if (n.kind === 'repo') {
        const e = n.entry;
        const lines = [
            `{cyan-fg}alias{/cyan-fg}            ${escTag(e.alias)}`,
            `{cyan-fg}id{/cyan-fg}               ${escTag(n.id)}`,
            `{cyan-fg}rootPath{/cyan-fg}         ${escTag(e.rootPath)}`,
            `{cyan-fg}chunks{/cyan-fg}           ${e.chunksCount}`,
            `{cyan-fg}lastIndexed{/cyan-fg}      ${e.lastIndexedAt ? new Date(e.lastIndexedAt).toISOString() : '(never)'}`,
            `{cyan-fg}lastCommit{/cyan-fg}       ${escTag(e.lastIndexedCommit || '(none)')}`,
            '',
            '{gray-fg}enter actions · i re-index · d drop · R reset baseline{/gray-fg}',
        ];

        return lines.join('\n');
    }
    if (n.kind === 'memory') {
        const m = n.entry;
        const lines = [
            `{cyan-fg}title{/cyan-fg}      {white-fg}${escTag(m.title)}{/white-fg}`,
            `{cyan-fg}kind{/cyan-fg}       ${escTag(m.kind)}`,
            `{cyan-fg}status{/cyan-fg}     ${escTag(m.status)}`,
            `{cyan-fg}id{/cyan-fg}         ${escTag(m.id)}`,
            `{cyan-fg}created{/cyan-fg}    ${new Date(m.createdAt).toISOString()}`,
            `{cyan-fg}updated{/cyan-fg}    ${new Date(m.updatedAt).toISOString()}`,
            `{cyan-fg}tags{/cyan-fg}       ${escTag(m.tags.join(', ') || '(none)')}`,
            `{cyan-fg}paths{/cyan-fg}      ${escTag(m.paths.join(', ') || '(none)')}`,
            `{cyan-fg}branch{/cyan-fg}     ${escTag(m.branch ?? '(none)')}`,
            `{cyan-fg}source{/cyan-fg}     ${escTag(m.source)}`,
            `{cyan-fg}resolution{/cyan-fg} ${escTag(m.resolution ?? '(none)')}`,
            '',
            '{gray-fg}enter actions · e edit body · t edit title · d delete{/gray-fg}',
        ];

        return lines.join('\n');
    }

    return `{green-fg}Press enter{/green-fg} to add a new long-term memory.`;
}

function renderBody(row: TreeRow | undefined, state: DashState): string {
    if (!row) return '';
    if (row.node.kind === 'memory') {
        const body = row.node.entry.body;
        if (!body.trim()) return '{gray-fg}(empty body){/gray-fg}';

        return escTag(body);
    }
    if (row.node.kind === 'repo') {
        const files = state.repoFiles[row.node.id] ?? [];
        if (files.length === 0) {
            return '{gray-fg}(no indexed files for this repo){/gray-fg}';
        }
        const totalChunks = files.reduce((s, f) => s + f.chunks, 0);
        const header = `{cyan-fg}{bold}${files.length} file${files.length === 1 ? '' : 's'}{/bold}{/cyan-fg}  {gray-fg}·{/gray-fg}  {yellow-fg}${totalChunks} chunks{/yellow-fg}\n\n`;
        const lines = files.map((f) => {
            const chunkChip = `{yellow-fg}${String(f.chunks).padStart(3)}{/yellow-fg}`;

            return `  ${chunkChip}  {white-fg}${escTag(f.path)}{/white-fg}`;
        });

        return header + lines.join('\n');
    }

    return '';
}

function pauseScreen(screen: blessed.Widgets.Screen): () => void {
    const program = (screen as unknown as {
        program: {
            normalBuffer: () => void;
            alternateBuffer: () => void;
            showCursor: () => void;
            hideCursor: () => void;
            disableMouse: () => void;
            enableMouse: () => void;
            pause: () => () => void;
        };
    }).program;
    let resume: (() => void) | undefined;
    try {
        resume = program.pause();
        program.normalBuffer();
        program.showCursor();
        program.disableMouse();
    } catch { /* ignore */ }

    return () => {
        try {
            program.alternateBuffer();
            program.enableMouse();
            program.hideCursor();
            if (resume) resume();
        } catch { /* ignore */ }
        screen.alloc();
        screen.render();
    };
}

async function editInVim(
    screen: blessed.Widgets.Screen,
    initial: string,
    suffix = '.md',
): Promise<string> {
    const tmp = path.join(os.tmpdir(), `kra-mem-edit-${Date.now()}${suffix}`);
    await fs.writeFile(tmp, initial, 'utf8');
    const restore = pauseScreen(screen);
    await new Promise<void>((resolve) => {
        const p = spawn('nvim', [tmp], { stdio: 'inherit' });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
    });
    restore();
    const out = await fs.readFile(tmp, 'utf8');
    await fs.unlink(tmp).catch(() => undefined);

    return out;
}
async function dropCodeChunksAt(entry: { repoKey?: string; rootPath: string; id?: string }): Promise<boolean> {
    const repoKey = entry.repoKey ?? (entry.id ? computeRepoKey(entry.id) : computeRepoKey(entry.rootPath));
    const lanceRoot = path.join(kraMemoryRepoRoot(repoKey), 'lance');
    try {
        const db = await lancedb.connect(lanceRoot);
        const names = await db.tableNames();
        if (!names.includes('code_chunks')) return false;
        await db.dropTable('code_chunks');

        return true;
    } catch {
        return false;
    }
}

export async function manageMemoryDashboard(): Promise<void> {
    let state = await loadState();
    const screen = createDashboardScreen({ title: 'kra-memory' });
    const expanded = new Set<string>(['g/findings', 'g/revisits', 'g/repos']);

    let filterQuery = '';
    const shell = createDashboardShell({
        screen,
        listLabel: 'memory',
        listFocusName: 'tree',
        listWidth: '50%',
        listItems: [],
        listTags: true,
        search: {
            label: 'search (s)',
            width: '50%',
        },
        detailPanels: [
            { label: 'details', focusName: 'details' },
            { label: 'body', focusName: 'body' },
        ],
        keymapText: () => {
            const filterChip = filterQuery
                ? `{yellow-bg}{black-fg} filter: ${escTag(filterQuery)} {/black-fg}{/yellow-bg}   `
                : '';

            return (
                filterChip +
                `{cyan-fg}tab{/cyan-fg} cycle  ` +
                `{cyan-fg}enter{/cyan-fg} actions  ` +
                `{cyan-fg}h/l{/cyan-fg} collapse/expand  ` +
                `{cyan-fg}a{/cyan-fg} add  ` +
                `{cyan-fg}e{/cyan-fg} edit body  ` +
                `{cyan-fg}t{/cyan-fg} title  ` +
                `{cyan-fg}d{/cyan-fg} delete  ` +
                `{cyan-fg}i{/cyan-fg} re-index  ` +
                `{cyan-fg}r{/cyan-fg} reload  {cyan-fg}R{/cyan-fg} reset baseline  ` +
                `{cyan-fg}[ ]{/cyan-fg} ±10  {cyan-fg}{ }{/cyan-fg} ±100  ` +
                `{cyan-fg}s{/cyan-fg} / {cyan-fg}/{/cyan-fg} search  ` +
                `{cyan-fg}q{/cyan-fg} quit`
            );
        },
    });
    const { header, ring } = shell;
    const searchBox = shell.searchBox;
    if (searchBox === null) throw new Error('memory dashboard requires a search box');
    const searchBar: blessed.Widgets.TextboxElement = searchBox;
    const tree = shell.list;
    const [details, body] = shell.detailPanels;

    let rows: TreeRow[] = [];

    function refreshHeader(): void {
        header.setContent(
            ` {magenta-fg}{bold}◆ kra-memory{/bold}{/magenta-fg}` +
            `   {cyan-fg}repos{/cyan-fg} {yellow-fg}${state.repos.length}{/yellow-fg}` +
            `   {cyan-fg}findings{/cyan-fg} {yellow-fg}${state.findings.length}{/yellow-fg}` +
            `   {cyan-fg}revisits{/cyan-fg} {yellow-fg}${state.revisits.length}{/yellow-fg}`,
        );
    }

    function rebuildRows(preserveId?: string): void {
        rows = buildRows(state, expanded, filterQuery);
        const items = rows.map(renderRow);
        tree.setItems(items);
        let restoreIdx = 0;
        if (preserveId) {
            const found = rows.findIndex((r) => r.id === preserveId);
            if (found >= 0) restoreIdx = found;
        }
        tree.select(restoreIdx);
        refreshHeader();
        refreshSidePanels();
        screen.render();
    }

    function refreshSidePanels(): void {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        details.setContent(renderDetails(row));
        details.setScrollPerc(0);
        body.setContent(renderBody(row, state));
        body.setScrollPerc(0);
    }

    async function reloadAll(preserveId?: string): Promise<void> {
        state = await loadState();
        rebuildRows(preserveId);
    }

    function flash(msg: string, color = 'green'): void {
        const prev = header.getContent();
        header.setContent(prev + `   {${color}-fg}${escTag(msg)}{/${color}-fg}`);
        screen.render();
        setTimeout(() => { refreshHeader(); screen.render(); }, 1500).unref();
    }

    async function reindexRepo(id: string, e: RegistryEntry): Promise<void> {
        try {
            const inspection = await inspectCurrentCodeIndex();
            if (path.resolve(e.rootPath) !== path.resolve(inspection.workspaceRoot)) {
                flash('can only re-index the current workspace', 'yellow');
                tree.focus();

                return;
            }

            let mode: 'full' | 'catchup' = inspection.needsFreshIndex ? 'full' : 'catchup';
            if (!inspection.needsFreshIndex && inspection.plan?.exceedsThreshold) {
                const useFull = await modalConfirm(
                    screen,
                    'Large re-index',
                    `Catch-up would reindex ${inspection.plan.changes.length} files. Run a full reindex instead?`,
                );
                if (useFull) mode = 'full';
            }

            const progressLines = [
                `{magenta-fg}{bold}re-indexing ${escTag(e.alias)}{/bold}{/magenta-fg}`,
                '',
            ];
            const renderProgress = (message: string): void => {
                progressLines.push(`{yellow-fg}${escTag(message)}{/yellow-fg}`);
                body.setContent(progressLines.join('\n'));
                body.setScrollPerc(100);
                screen.render();
            };

            renderProgress(mode === 'full' ? 'Starting full reindex...' : 'Starting incremental catch-up...');
            const result = await runCurrentCodeIndex({
                inspection,
                mode,
                onProgress: (progress) => {
                    const suffix = progress.filesTotal > 0
                        ? ` (${Math.min(progress.filesDone, progress.filesTotal)}/${progress.filesTotal})`
                        : '';
                    renderProgress(`${progress.message}${suffix}`);
                },
            });
            await reloadAll(`repo/${id}`);
            flash(result.summary);
        } catch (err) {
            flash(err instanceof Error ? err.message : String(err), 'red');
        }
        tree.focus();
    }

    async function memoryActions(m: MemoryEntry): Promise<void> {
        const action = await modalChoice(screen, m.title, [
            'Edit body',
            'Edit title',
            'Edit tags',
            'Change status',
            'Delete',
        ]);
        if (action.value === null) {
            tree.focus();

            return;
        }
        switch (action.value) {
            case 'View body':
                await editInVim(screen, m.body, '.md');
                tree.focus();
                break;
            case 'Edit body': {
                const next = await editInVim(screen, m.body, '.md');
                const trimmed = next.replace(/\s+$/, '');
                if (trimmed !== m.body && trimmed.length > 0) {
                    const ok = await modalConfirm(screen, 'Save', `Save edited body for '${m.title}'?`);
                    if (ok) {
                        await editMemory({ id: m.id, body: trimmed });
                        await reloadAll(`mem/${m.id}`);
                        flash('saved');
                    }
                }
                tree.focus();
                break;
            }
            case 'Edit title': {
                const r = await modalText(screen, 'New title', m.title);
                if (r.value?.trim()) {
                    await editMemory({ id: m.id, title: r.value.trim() });
                    await reloadAll(`mem/${m.id}`);
                    flash('title updated');
                }
                tree.focus();
                break;
            }
            case 'Edit tags': {
                const r = await modalText(screen, 'Tags (comma-separated)', m.tags.join(', '));
                if (r.value !== null) {
                    const tags = r.value.split(',').map((s) => s.trim()).filter(Boolean);
                    await editMemory({ id: m.id, tags });
                    await reloadAll(`mem/${m.id}`);
                    flash('tags updated');
                }
                tree.focus();
                break;
            }
            case 'Change status': {
                const r = await modalChoice(screen, 'New status', [...MEMORY_STATUSES], m.status);
                if (r.value !== null) {
                    await updateMemory({ id: m.id, status: r.value as MemoryStatus });
                    await reloadAll(`mem/${m.id}`);
                    flash('status updated');
                }
                tree.focus();
                break;
            }
            case 'Delete': {
                const ok = await modalConfirm(screen, 'Delete memory',
                    `Delete '${m.title}'? This cannot be undone.`);
                if (ok) {
                    await deleteMemory(m.id);
                    await reloadAll();
                    flash('deleted');
                }
                tree.focus();
                break;
            }
        }
    }

    async function repoActions(id: string, e: RegistryEntry): Promise<void> {
        const action = await modalChoice(screen, e.alias, [
            'Re-index now',
            'Drop index (delete code_chunks + registry entry)',
            'Reset baseline (force full reindex on next launch)',
            'Rename alias',
        ]);
        if (action.value === null) {
            tree.focus();

            return;
        }
        switch (action.value) {
            case 'Re-index now': {
                await reindexRepo(id, e);
                break;
            }
            case 'Drop index (delete code_chunks + registry entry)': {
                const ok = await modalConfirm(screen, 'Drop index',
                    `Drop code_chunks for '${e.alias}' AND remove registry entry? Long-term memories untouched.`);
                if (ok) {
                    const dropped = await dropCodeChunksAt(e);
                    await removeRegistryEntry(id);
                    await reloadAll();
                    flash(dropped ? 'dropped + removed' : 'no chunks; registry cleared');
                }
                tree.focus();
                break;
            }
            case 'Reset baseline (force full reindex on next launch)': {
                const ok = await modalConfirm(screen, 'Reset baseline',
                    `Clear lastIndexedCommit/lastIndexedAt for '${e.alias}'?`);
                if (ok) {
                    await upsertRegistryEntry(id, { lastIndexedCommit: '', lastIndexedAt: 0 });
                    await reloadAll(`repo/${id}`);
                    flash('baseline cleared');
                }
                tree.focus();
                break;
            }
            case 'Rename alias': {
                const r = await modalText(screen, `New alias for '${e.alias}'`, e.alias);
                if (r.value?.trim()) {
                    await upsertRegistryEntry(id, { alias: r.value.trim() });
                    await reloadAll(`repo/${id}`);
                    flash('renamed');
                }
                tree.focus();
                break;
            }
        }
    }

    async function addNewMemory(): Promise<void> {
        const kindR = await modalChoice(screen, 'Memory kind', [...MEMORY_KINDS]);
        if (kindR.value === null) {
            tree.focus();

            return;
        }
        const kind = kindR.value as MemoryKind;
        const titleR = await modalText(screen, 'Title (single line)', '');
        if (!titleR.value?.trim()) {
            tree.focus();

            return;
        }
        const title = titleR.value.trim();
        const placeholder = `# Body for: ${title}\n# Write the memory body below. Save and exit to continue. Empty cancels.\n\n`;
        const raw = await editInVim(screen, placeholder, '.md');
        const bodyText = raw
            .split('\n')
            .filter((l) => !l.startsWith('#'))
            .join('\n')
            .trim();
        if (!bodyText) {
            flash('empty body — cancelled', 'yellow'); tree.focus();

            return;
        }
        const tagsR = await modalText(screen, 'Tags (comma-separated, optional)', '');
        const tags = tagsR.value
            ? tagsR.value.split(',').map((t) => t.trim()).filter(Boolean)
            : [];
        const saved = await remember({ kind, title, body: bodyText, tags });
        await reloadAll(`mem/${saved.id}`);
        flash('memory saved');
        tree.focus();
    }

    function focusSearch(): void {
        searchBar.focus();
        searchBar.readInput();
        screen.render();
    }

    searchBar.on('keypress', () => {
        setImmediate(() => {
            const v = searchBar.getValue();
            if (v !== filterQuery) {
                filterQuery = v;
                rebuildRows();
                ring.renderFooter();
                screen.render();
                rebuildRows();
            }
        });
    });
    searchBar.key(['enter'], () => { tree.focus(); });
    searchBar.key(['escape'], () => {
        searchBar.clearValue();
        if (filterQuery) {
            filterQuery = '';
            rebuildRows();
            ring.renderFooter();
        }
        tree.focus();
    });

    function selectedRow(): TreeRow | undefined {
        const sel = (tree as unknown as { selected: number }).selected;

        return rows[sel];
    }

    tree.on('select item', () => {
        refreshSidePanels();
        screen.render();
    });

    tree.key(['enter'], async () => {
        const row = selectedRow();
        if (!row) return;
        if (toggleExpandedRow(row, expanded, rebuildRows)) {
            return;
        }
        if (row.node.kind === 'memory') {
            await memoryActions(row.node.entry);
        } else if (row.node.kind === 'repo') {
            await repoActions(row.node.id, row.node.entry);
        } else if (row.node.kind === 'add') {
            await addNewMemory();
        }
    });

    tree.key(['a'], async () => {
        await addNewMemory();
    });

    tree.key(['e'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'memory') {
            flash('not a memory', 'yellow');

            return;
        }
        const m = row.node.entry;
        const next = await editInVim(screen, m.body, '.md');
        const trimmed = next.replace(/\s+$/, '');
        if (trimmed !== m.body && trimmed.length > 0) {
            const ok = await modalConfirm(screen, 'Save', `Save edited body for '${m.title}'?`);
            if (ok) {
                await editMemory({ id: m.id, body: trimmed });
                await reloadAll(`mem/${m.id}`);
                flash('saved');
            }
        }
        tree.focus();
    });

    tree.key(['t'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'memory') {
            flash('not a memory', 'yellow');

            return;
        }

        const m = row.node.entry;
        const r = await modalText(screen, 'New title', m.title);
        if (r.value?.trim()) {
            await editMemory({ id: m.id, title: r.value.trim() });
            await reloadAll(`mem/${m.id}`);
            flash('title updated');
        }
        tree.focus();
    });

    tree.key(['s', '/'], async () => {
        await Promise.resolve();
        focusSearch();
    });

    tree.key(['d'], async () => {
        const row = selectedRow();
        if (!row) return;
        if (row.node.kind === 'memory') {
            const m = row.node.entry;
            const ok = await modalConfirm(screen, 'Delete memory',
                `Delete '${m.title}'? This cannot be undone.`);
            if (ok) {
                await deleteMemory(m.id);
                await reloadAll();
                flash('deleted');
            }
        } else if (row.node.kind === 'repo') {
            const e = row.node.entry;
            const ok = await modalConfirm(screen, 'Drop index',
                `Drop code_chunks for '${e.alias}' AND remove registry entry?`);
            if (ok) {
                const dropped = await dropCodeChunksAt(e);
                await removeRegistryEntry(row.node.id);
                await reloadAll();
                flash(dropped ? 'dropped + removed' : 'registry cleared');
            }
        } else {
            flash('nothing to delete here', 'yellow');
        }
        tree.focus();
    });

    tree.key(['i'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'repo') {
            flash('not a repo', 'yellow');

            return;
        }
        await reindexRepo(row.node.id, row.node.entry);
    });

    tree.key(['S-r'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'repo') {
            flash('not a repo', 'yellow');

            return;
        }
        const e = row.node.entry;
        const ok = await modalConfirm(screen, 'Reset baseline',
            `Clear lastIndexedCommit/lastIndexedAt for '${e.alias}'?`);
        if (ok) {
            await upsertRegistryEntry(row.node.id, { lastIndexedCommit: '', lastIndexedAt: 0 });
            await reloadAll(`repo/${row.node.id}`);
            flash('baseline cleared');
        }
        tree.focus();
    });

    tree.key(['r'], async () => {
        const row = selectedRow();
        await reloadAll(row?.id);
        flash('reloaded');
    });

    attachTreeExpandCollapseKeys({
        tree,
        getRows: () => rows,
        getSelectedIndex: () => (tree as unknown as { selected: number }).selected,
        expanded,
        rebuild: rebuildRows,
        onSelect: () => {
            refreshSidePanels();
            screen.render();
        },
    });
    attachVerticalNavigation(tree, {
        moveBy: (delta) => {
            if (rows.length === 0) return;
            const cur = (tree as unknown as { selected: number }).selected || 0;
            const next = Math.abs(delta) === 1
                ? (cur + delta + rows.length) % rows.length
                : Math.max(0, Math.min(rows.length - 1, cur + delta));
            tree.select(next);
            refreshSidePanels();
            screen.render();
        },
        top: () => {
            if (rows.length === 0) return;
            tree.select(0);
            refreshSidePanels();
            screen.render();
        },
        bottom: () => {
            if (rows.length === 0) return;
            tree.select(rows.length - 1);
            refreshSidePanels();
            screen.render();
        },
    });

    attachFocusCycleKeys(screen, ring);

    rebuildRows();
    ring.focusAt(0);
    tree.select(0);
    refreshSidePanels();
    screen.render();

    await awaitScreenDestroy(screen);
}
