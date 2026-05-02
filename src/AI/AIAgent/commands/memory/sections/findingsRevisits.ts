import blessed from 'blessed';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    deleteMemory,
    editMemory,
    listMemories,
    remember,
    updateMemory,
} from '@/AI/AIAgent/shared/memory/notes';
import {
    MEMORY_KINDS,
    MEMORY_STATUSES,
    isRevisitKind,
    type MemoryEntry,
    type MemoryKind,
    type MemoryStatus,
} from '@/AI/AIAgent/shared/memory/types';
import {
    attachTreeExpandCollapseKeys,
    attachVerticalNavigation,
    createDashboardList,
    createDashboardSearchBox,
    createDashboardTextPanel,
    escTag,
    modalChoice,
    modalConfirm,
    modalText,
    type FocusPanel,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';

export interface MemorySectionHandle {
    destroy: () => void;
    focus: () => void;
    panels: FocusPanel[];
    keymap: () => string;
}

interface NodeGroup {
    kind: 'group';
    id: 'findings' | 'revisits';
    label: string;
    children: MemoryEntry[];
}
interface NodeMemory {
    kind: 'memory';
    entry: MemoryEntry;
}
interface NodeAdd {
    kind: 'add';
}

type Node = NodeGroup | NodeMemory | NodeAdd;

interface Row {
    id: string;
    depth: number;
    node: Node;
    open?: boolean;
}

export function mountFindingsRevisitsSection(opts: {
    screen: blessed.Widgets.Screen;
    parent: blessed.Widgets.BoxElement;
    setStatus: (text: string) => void;
}): MemorySectionHandle {
    const { screen, parent, setStatus } = opts;

    const search = createDashboardSearchBox(parent, {
        label: 'search (s / /)',
        top: 0,
        left: 0,
        width: '50%',
        height: 3,
        borderColor: 'green',
        inputOnFocus: true,
    });

    const tree = createDashboardList(parent, {
        label: 'findings + revisits',
        top: 3,
        left: 0,
        width: '50%',
        height: '100%-3',
        borderColor: 'cyan',
        tags: true,
        keys: false,
        vi: false,
        mouse: true,
    });

    const details = createDashboardTextPanel(parent, {
        label: 'details',
        top: 0,
        left: '50%',
        width: '50%',
        height: '45%',
        borderColor: 'yellow',
        tags: true,
    });

    const body = createDashboardTextPanel(parent, {
        label: 'body',
        top: '45%',
        left: '50%',
        width: '50%',
        height: '55%',
        borderColor: 'magenta',
        tags: true,
    });

    let findings: MemoryEntry[] = [];
    let revisits: MemoryEntry[] = [];
    let filterQuery = '';
    const expanded = new Set<string>(['g/findings', 'g/revisits']);
    let rows: Row[] = [];

    function shortDate(ts: number): string {
        return new Date(ts).toISOString().slice(0, 10);
    }

    function keymapText(): string {
        return '{cyan-fg}s,//{/cyan-fg} filter · {cyan-fg}enter{/cyan-fg} expand/actions · {cyan-fg}a{/cyan-fg} add · {cyan-fg}e/t/d{/cyan-fg} edit';
    }

    function flash(text: string, color = 'green'): void {
        setStatus(`{${color}-fg}${escTag(text)}{/${color}-fg}`);
        setTimeout(() => setStatus(keymapText()), 1400).unref();
    }

    async function load(): Promise<void> {
        const all = await listMemories({ scope: 'all', limit: 500 });
        findings = [];
        revisits = [];
        for (const m of all) {
            if (isRevisitKind(m.kind)) revisits.push(m);
            else findings.push(m);
        }
    }

    function matches(m: MemoryEntry): boolean {
        if (!filterQuery) return true;
        const q = filterQuery.toLowerCase();

        return m.title.toLowerCase().includes(q)
            || m.kind.toLowerCase().includes(q)
            || m.body.toLowerCase().includes(q)
            || m.tags.some((t) => t.toLowerCase().includes(q));
    }

    function buildRows(): Row[] {
        const out: Row[] = [];
        const groups: NodeGroup[] = [
            { kind: 'group', id: 'findings', label: `Findings (${findings.length})`, children: findings },
            { kind: 'group', id: 'revisits', label: `Revisits (${revisits.length})`, children: revisits },
        ];

        for (const g of groups) {
            const id = `g/${g.id}`;
            const filtered = filterQuery ? g.children.filter(matches) : g.children;
            if (filterQuery && filtered.length === 0) continue;
            const open = filterQuery ? true : expanded.has(id);
            out.push({ id, depth: 0, node: { ...g, children: filtered }, open });
            if (open) {
                for (const child of filtered) {
                    out.push({ id: `mem/${child.id}`, depth: 1, node: { kind: 'memory', entry: child } });
                }
            }
        }

        if (!filterQuery) {
            out.push({ id: 'add', depth: 0, node: { kind: 'add' } });
        }

        return out;
    }

    function renderRow(row: Row): string {
        const indent = '  '.repeat(row.depth);
        if (row.node.kind === 'group') {
            const arrow = row.open ? '▼' : '▶';

            return `${indent}{magenta-fg}${arrow}{/magenta-fg} {magenta-fg}{bold}${escTag(row.node.label)}{/bold}{/magenta-fg}`;
        }
        if (row.node.kind === 'memory') {
            const m = row.node.entry;
            const statusIcon = m.status === 'open' ? '{yellow-fg}○{/yellow-fg}' : m.status === 'resolved' ? '{green-fg}●{/green-fg}' : '{gray-fg}●{/gray-fg}';

            return `${indent}${statusIcon} {cyan-fg}[${escTag(m.kind)}]{/cyan-fg} {gray-fg}${shortDate(m.createdAt)}{/gray-fg} {white-fg}${escTag(m.title)}{/white-fg}`;
        }

        return `${indent}{green-fg}+{/green-fg} {green-fg}add new memory{/green-fg}`;
    }

    function renderDetails(row?: Row): string {
        if (!row) return '';
        if (row.node.kind === 'group') {
            const count = row.node.children.length;

            return `{magenta-fg}{bold}${escTag(row.node.label)}{/bold}{/magenta-fg}\n\n{gray-fg}${count} item${count === 1 ? '' : 's'}{/gray-fg}`;
        }
        if (row.node.kind === 'memory') {
            const m = row.node.entry;

            return [
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
            ].join('\n');
        }

        return '{green-fg}Press enter{/green-fg} to add a new memory.';
    }

    function renderBody(row?: Row): string {
        if (!row || row.node.kind !== 'memory') return '';
        if (!row.node.entry.body.trim()) return '{gray-fg}(empty body){/gray-fg}';

        return escTag(row.node.entry.body);
    }

    function selectedRow(): Row | undefined {
        const idx = (tree as unknown as { selected: number }).selected || 0;

        return rows[idx];
    }

    function refreshPanels(): void {
        const row = selectedRow();
        details.setContent(renderDetails(row));
        details.setScrollPerc(0);
        body.setContent(renderBody(row));
        body.setScrollPerc(0);
    }

    function rebuild(preserveId?: string): void {
        rows = buildRows();
        tree.setItems(rows.map(renderRow));
        const idx = preserveId ? rows.findIndex((r) => r.id === preserveId) : 0;
        tree.select(idx >= 0 ? idx : 0);
        refreshPanels();
        screen.render();
    }

    function moveTreeBy(delta: number): void {
        if (rows.length === 0) return;
        const current = (tree as unknown as { selected?: number }).selected ?? 0;
        const next = Math.max(0, Math.min(rows.length - 1, current + delta));
        tree.select(next);
        refreshPanels();
        screen.render();
    }

    async function editInEditor(initial: string): Promise<string> {
        const tmp = path.join(os.tmpdir(), `kra-mem-edit-${Date.now()}.md`);
        await fs.writeFile(tmp, initial, 'utf8');

        const editorRaw = process.env.EDITOR?.trim() || 'nvim';
        const [cmd, ...baseArgs] = editorRaw.split(/\s+/).filter(Boolean);
        await runInherit(cmd, [...baseArgs, tmp], screen);

        const out = await fs.readFile(tmp, 'utf8');
        await fs.unlink(tmp).catch(() => undefined);

        return out;
    }

    async function reload(preserveId?: string): Promise<void> {
        await load();
        rebuild(preserveId);
    }

    async function addMemory(): Promise<void> {
        const kindR = await modalChoice(screen, 'Memory kind', [...MEMORY_KINDS]);
        if (kindR.value === null) return;
        const kind = kindR.value as MemoryKind;
        const titleR = await modalText(screen, 'Title (single line)', '');
        if (!titleR.value?.trim()) return;
        const title = titleR.value.trim();

        const placeholder = `# Body for: ${title}\n# Write the memory body below. Save and exit to continue. Empty cancels.\n\n`;
        const raw = await editInEditor(placeholder);
        const bodyText = raw.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
        if (!bodyText) {
            flash('empty body — cancelled', 'yellow');

            return;
        }

        const tagsR = await modalText(screen, 'Tags (comma-separated, optional)', '');
        const tags = tagsR.value ? tagsR.value.split(',').map((t) => t.trim()).filter(Boolean) : [];
        const saved = await remember({ kind, title, body: bodyText, tags });
        await reload(`mem/${saved.id}`);
        flash('memory saved');
    }

    async function memoryActions(m: MemoryEntry): Promise<void> {
        const action = await modalChoice(screen, m.title, [
            'Edit body',
            'Edit title',
            'Edit tags',
            'Change status',
            'Delete',
        ]);
        if (action.value === null) return;

        if (action.value === 'Edit body') {
            const next = await editInEditor(m.body);
            const trimmed = next.replace(/\s+$/, '');
            if (trimmed !== m.body && trimmed.length > 0) {
                const ok = await modalConfirm(screen, 'Save', `Save edited body for '${m.title}'?`);
                if (ok) {
                    await editMemory({ id: m.id, body: trimmed });
                    await reload(`mem/${m.id}`);
                    flash('saved');
                }
            }

            return;
        }

        if (action.value === 'Edit title') {
            const r = await modalText(screen, 'New title', m.title);
            if (r.value?.trim()) {
                await editMemory({ id: m.id, title: r.value.trim() });
                await reload(`mem/${m.id}`);
                flash('title updated');
            }

            return;
        }

        if (action.value === 'Edit tags') {
            const r = await modalText(screen, 'Tags (comma-separated)', m.tags.join(', '));
            if (r.value !== null) {
                const tags = r.value.split(',').map((s) => s.trim()).filter(Boolean);
                await editMemory({ id: m.id, tags });
                await reload(`mem/${m.id}`);
                flash('tags updated');
            }

            return;
        }

        if (action.value === 'Change status') {
            const r = await modalChoice(screen, 'New status', [...MEMORY_STATUSES], m.status);
            if (r.value !== null) {
                await updateMemory({ id: m.id, status: r.value as MemoryStatus });
                await reload(`mem/${m.id}`);
                flash('status updated');
            }

            return;
        }

        const ok = await modalConfirm(screen, 'Delete memory', `Delete '${m.title}'? This cannot be undone.`);
        if (ok) {
            await deleteMemory(m.id);
            await reload();
            flash('deleted');
        }
    }

    tree.on('select item', () => {
        refreshPanels();
        screen.render();
    });

    attachVerticalNavigation(tree as unknown as blessed.Widgets.BlessedElement & {
        key: (keys: string[] | string, handler: () => void) => unknown;
    }, {
        moveBy: moveTreeBy,
        top: () => {
            if (rows.length === 0) return;
            tree.select(0);
            refreshPanels();
            screen.render();
        },
        bottom: () => {
            if (rows.length === 0) return;
            tree.select(rows.length - 1);
            refreshPanels();
            screen.render();
        },
    });

    attachTreeExpandCollapseKeys({
        tree: tree as unknown as blessed.Widgets.ListElement & {
            key: (keys: string[] | string, handler: () => void) => unknown;
            select: (index: number) => void;
        },
        getRows: () => rows.map((r) => ({
            id: r.id,
            depth: r.depth,
            expandable: r.node.kind === 'group',
            isOpen: r.node.kind === 'group' ? expanded.has(r.id) : false,
        })),
        getSelectedIndex: () => (tree as unknown as { selected: number }).selected ?? 0,
        expanded,
        rebuild: (preserveId?: string) => rebuild(preserveId),
        onSelect: () => {
            refreshPanels();
            screen.render();
        },
    });

    tree.key(['enter'], async () => {
        const row = selectedRow();
        if (!row) return;
        if (row.node.kind === 'group') {
            const id = row.id;
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            rebuild(id);

            return;
        }
        if (row.node.kind === 'add') {
            await addMemory();

            return;
        }
        await memoryActions(row.node.entry);
        tree.focus();
    });

    tree.key(['a'], async () => { await addMemory(); tree.focus(); });
    tree.key(['e'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'memory') {
            flash('not a memory', 'yellow');

            return;
        }
        const next = await editInEditor(row.node.entry.body);
        const trimmed = next.replace(/\s+$/, '');
        if (trimmed !== row.node.entry.body && trimmed.length > 0) {
            const ok = await modalConfirm(screen, 'Save', `Save edited body for '${row.node.entry.title}'?`);
            if (ok) {
                await editMemory({ id: row.node.entry.id, body: trimmed });
                await reload(`mem/${row.node.entry.id}`);
                flash('saved');
            }
        }
    });
    tree.key(['t'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'memory') {
            flash('not a memory', 'yellow');

            return;
        }
        const r = await modalText(screen, 'New title', row.node.entry.title);
        if (r.value?.trim()) {
            await editMemory({ id: row.node.entry.id, title: r.value.trim() });
            await reload(`mem/${row.node.entry.id}`);
            flash('title updated');
        }
    });
    tree.key(['d'], async () => {
        const row = selectedRow();
        if (!row || row.node.kind !== 'memory') {
            flash('not a memory', 'yellow');

            return;
        }
        const ok = await modalConfirm(screen, 'Delete memory', `Delete '${row.node.entry.title}'? This cannot be undone.`);
        if (ok) {
            await deleteMemory(row.node.entry.id);
            await reload();
            flash('deleted');
        }
    });
    const focusSearch = (): void => {
        search.focus();
        search.readInput();
    };
    tree.key(['s', '/'], focusSearch);
    (details as unknown as { key: (k: string[], h: () => void) => void }).key(['s', '/'], focusSearch);
    (body as unknown as { key: (k: string[], h: () => void) => void }).key(['s', '/'], focusSearch);
    tree.key(['r'], async () => {
        await reload(selectedRow()?.id);
        flash('reloaded');
    });

    search.on('keypress', () => {
        setImmediate(() => {
            const v = search.getValue();
            if (v !== filterQuery) {
                filterQuery = v;
                rebuild();
            }
        });
    });
    search.key(['enter'], () => tree.focus());
    search.key(['escape'], () => {
        search.clearValue();
        if (filterQuery) {
            filterQuery = '';
            rebuild();
        }
        tree.focus();
    });

    void reload().then(() => {
        setStatus(keymapText());
        tree.focus();
    });

    return {
        destroy: () => {
            search.destroy();
            tree.destroy();
            details.destroy();
            body.destroy();
        },
        focus: () => tree.focus(),
        panels: [
            { el: tree, name: 'tree', color: 'cyan' },
            { el: details, name: 'details', color: 'yellow' },
            { el: body, name: 'body', color: 'magenta' },
        ],
        keymap: keymapText,
    };
}
