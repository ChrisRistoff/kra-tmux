import blessed from 'blessed';
import * as fs from 'fs/promises';
import * as toml from 'smol-toml';
import { settingsFilePath } from '@/filePaths';
import { settingsExamplePath } from '@/packagePaths';
import { parseSchema } from './parseSchema';
import {
    setLeaf,
    addCollectionItem,
    removeCollectionItem,
    addMapItem,
    removeMapItem,
    formatTomlValue,
    validate,
} from './rewriter';
import type {
    Schema,
    SchemaNode,
    LeafNode,
    SectionNode,
    CollectionNode,
    MapNode,
    LeafType,
} from './types';
import {
    escTag,
    modalText,
    modalChoice,
    modalConfirm,
    createDashboardScreen,
    awaitScreenDestroy,
    createDashboardShell,
    attachFocusCycleKeys,
    attachVerticalNavigation,
    attachTreeExpandCollapseKeys,
    toggleExpandedRow,
    type OverlayResult,
} from '@/UI/dashboard';

interface SettingsCtx {
    schema: Schema;
    text: string;
    parsed: unknown;
}

interface TreeRow {
    id: string;
    depth: number;
    kind:
        | 'section'
        | 'collection'
        | 'map'
        | 'leaf'
        | 'collection-item'
        | 'map-entry'
        | 'item-leaf'
        | 'add-collection'
        | 'add-map';
    label: string;
    valuePreview?: string;
    expandable: boolean;
    isOpen?: boolean;
    node?: SchemaNode;
    parentCollection?: CollectionNode;
    parentMap?: MapNode;
    itemIndex?: number;
    mapKey?: string;
    itemFieldNode?: LeafNode;
    fullPath?: string[];
    isDirty?: boolean;
}


function getAt(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;
    for (const seg of path) {
        if (cur && typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
    }

    return cur;
}

function getAtIndexed(obj: unknown, path: (string | number)[]): unknown {
    let cur: unknown = obj;
    for (const seg of path) {
        if (cur === undefined || cur === null) return undefined;
        if (typeof seg === 'number') {
            if (!Array.isArray(cur)) return undefined;
            cur = cur[seg];
        } else {
            if (typeof cur !== 'object') return undefined;
            cur = (cur as Record<string, unknown>)[seg];
        }
    }

    return cur;
}

function previewLeaf(value: unknown, n: LeafNode): string {
    if (value === undefined) value = n.default;
    if (n.secret && value !== undefined && value !== '') return '••••••••';
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (typeof value === 'string') {
        if (value.length === 0) return '""';

        return value.length > 50 ? `"${value.slice(0, 47)}..."` : `"${value}"`;
    }
    if (value === undefined) return '<unset>';
    if (typeof value === 'boolean') return value ? '✓ true' : '☐ false';

    return String(value);
}

function isDirty(value: unknown, def: unknown): boolean {
    if (Array.isArray(value) && Array.isArray(def)) {
        return JSON.stringify(value) !== JSON.stringify(def);
    }

    return value !== undefined && value !== def;
}

function nodeLabel(n: SchemaNode): string {
    if (n.kind === 'leaf') return n.label ?? n.key;
    if (n.kind === 'section') return n.label ?? n.title;

    return n.label ?? n.title;
}

function leafIcon(t: LeafType): string {
    switch (t) {
        case 'bool': return '◉';
        case 'number': return '#';
        case 'string': return '"';
        case 'string-array': return '⋮';
        case 'unknown': return '?';
    }
}

function buildRows(
    ctx: SettingsCtx,
    expanded: Set<string>,
): TreeRow[] {
    const rows: TreeRow[] = [];

    const visitNode = (
        node: SchemaNode,
        depth: number,
        parentId: string,
    ): void => {
        const id = `${parentId}/${node.path.join('.')}`;
        if (node.kind === 'leaf') {
            const v = getAt(ctx.parsed, node.path);
            rows.push({
                id,
                depth,
                kind: 'leaf',
                label: nodeLabel(node),
                valuePreview: previewLeaf(v, node),
                expandable: false,
                node,
                fullPath: node.path,
                isDirty: isDirty(v, node.default),
            });

            return;
        }
        if (node.kind === 'section') {
            const isOpen = expanded.has(id);
            rows.push({
                id,
                depth,
                kind: 'section',
                label: nodeLabel(node),
                expandable: true,
                isOpen,
                node,
            });
            if (isOpen) {
                for (const child of node.children) visitNode(child, depth + 1, id);
            }

            return;
        }
        if (node.kind === 'collection') {
            const isOpen = expanded.has(id);
            const arr = (getAt(ctx.parsed, node.path) as Record<string, unknown>[] | undefined) ?? [];
            rows.push({
                id,
                depth,
                kind: 'collection',
                label: `${nodeLabel(node)} [${arr.length}]`,
                expandable: true,
                isOpen,
                node,
            });
            if (isOpen) {
                arr.forEach((item, idx) => {
                    const itemId = `${id}#${idx}`;
                    const itemOpen = expanded.has(itemId);
                    const display = displayItemLabel(node, item, idx);
                    rows.push({
                        id: itemId,
                        depth: depth + 1,
                        kind: 'collection-item',
                        label: display,
                        expandable: true,
                        isOpen: itemOpen,
                        parentCollection: node,
                        itemIndex: idx,
                    });
                    if (itemOpen) {
                        for (const f of node.itemFields) {
                            const fpath = [...node.path, String(idx), f.key];
                            const v = getAtIndexed(ctx.parsed, [...node.path, idx, f.key]);
                            rows.push({
                                id: `${itemId}/${f.key}`,
                                depth: depth + 2,
                                kind: 'item-leaf',
                                label: nodeLabel(f),
                                valuePreview: previewLeaf(v, f),
                                expandable: false,
                                itemFieldNode: f,
                                fullPath: fpath,
                                parentCollection: node,
                                itemIndex: idx,
                                isDirty: isDirty(v, f.default),
                            });
                        }
                    }
                });
                rows.push({
                    id: `${id}#+add`,
                    depth: depth + 1,
                    kind: 'add-collection',
                    label: '+ add new item',
                    expandable: false,
                    parentCollection: node,
                });
            }

            return;
        }
        if (node.kind === 'map') {
            const isOpen = expanded.has(id);
            const raw = getAt(ctx.parsed, node.path);
            const m: Record<string, Record<string, unknown>> =
                raw && typeof raw === 'object' ? (raw as Record<string, Record<string, unknown>>) : {};
            const keys = Object.keys(m);
            rows.push({
                id,
                depth,
                kind: 'map',
                label: `${nodeLabel(node)} {${keys.length}}`,
                expandable: true,
                isOpen,
                node,
            });
            if (isOpen) {
                for (const key of keys) {
                    const entryId = `${id}#${key}`;
                    const entryOpen = expanded.has(entryId);
                    rows.push({
                        id: entryId,
                        depth: depth + 1,
                        kind: 'map-entry',
                        label: key,
                        expandable: true,
                        isOpen: entryOpen,
                        parentMap: node,
                        mapKey: key,
                    });
                    if (entryOpen) {
                        for (const f of node.itemFields) {
                            const fpath = [...node.path, key, f.key];
                            const v = getAt(ctx.parsed, fpath);
                            rows.push({
                                id: `${entryId}/${f.key}`,
                                depth: depth + 2,
                                kind: 'item-leaf',
                                label: nodeLabel(f),
                                valuePreview: previewLeaf(v, f),
                                expandable: false,
                                itemFieldNode: f,
                                fullPath: fpath,
                                parentMap: node,
                                mapKey: key,
                                isDirty: isDirty(v, f.default),
                            });
                        }
                    }
                }
                rows.push({
                    id: `${id}#+add`,
                    depth: depth + 1,
                    kind: 'add-map',
                    label: '+ add new entry',
                    expandable: false,
                    parentMap: node,
                });
            }

            return;
        }
    };

    for (const c of ctx.schema.children) visitNode(c, 0, 'root');

    return rows;
}

function displayItemLabel(
    node: CollectionNode,
    item: Record<string, unknown>,
    idx: number,
): string {
    const key = node.displayKey;
    if (key && typeof item[key] === 'string') return `${idx + 1}. ${item[key]}`;
    const firstStr = node.itemFields.find((f) => f.type === 'string' && typeof item[f.key] === 'string');
    if (firstStr) return `${idx + 1}. ${item[firstStr.key] as string}`;

    return `${idx + 1}.`;
}

function renderRow(row: TreeRow, focused: boolean): string {
    const indent = '  '.repeat(row.depth);
    const dirty = row.isDirty ? '{yellow-fg}*{/yellow-fg}' : ' ';
    let icon = '';
    let label = '';
    switch (row.kind) {
        case 'section':
            icon = row.isOpen ? '{magenta-fg}▼{/magenta-fg}' : '{magenta-fg}▶{/magenta-fg}';
            label = `{magenta-fg}{bold}${escTag(row.label)}{/bold}{/magenta-fg}`;
            break;
        case 'collection':
            icon = row.isOpen ? '{cyan-fg}▼{/cyan-fg}' : '{cyan-fg}▶{/cyan-fg}';
            label = `{cyan-fg}{bold}${escTag(row.label)}{/bold}{/cyan-fg}`;
            break;
        case 'map':
            icon = row.isOpen ? '{cyan-fg}▼{/cyan-fg}' : '{cyan-fg}▶{/cyan-fg}';
            label = `{cyan-fg}{bold}${escTag(row.label)}{/bold}{/cyan-fg}`;
            break;
        case 'collection-item':
        case 'map-entry':
            icon = row.isOpen ? '{green-fg}▾{/green-fg}' : '{green-fg}▸{/green-fg}';
            label = `{green-fg}${escTag(row.label)}{/green-fg}`;
            break;
        case 'leaf': {
            const t = (row.node as LeafNode).type;
            icon = `{gray-fg}${leafIcon(t)}{/gray-fg}`;
            const val = row.valuePreview ?? '';
            label = `${escTag(row.label)} {gray-fg}={/gray-fg} {white-fg}${escTag(val)}{/white-fg}`;
            break;
        }
        case 'item-leaf': {
            const t = (row.itemFieldNode as LeafNode).type;
            icon = `{gray-fg}${leafIcon(t)}{/gray-fg}`;
            const val = row.valuePreview ?? '';
            label = `${escTag(row.label)} {gray-fg}={/gray-fg} {white-fg}${escTag(val)}{/white-fg}`;
            break;
        }
        case 'add-collection':
        case 'add-map':
            icon = '{green-fg}+{/green-fg}';
            label = `{green-fg}${escTag(row.label)}{/green-fg}`;
            break;
    }
    void focused;

    return `${indent}${icon} ${dirty} ${label}`;
}

function renderDetails(ctx: SettingsCtx, row: TreeRow | undefined): string {
    if (!row) return '{gray-fg}(no selection){/gray-fg}';
    const lines: string[] = [];
    if (row.kind === 'leaf' || row.kind === 'item-leaf') {
        const f = (row.kind === 'leaf' ? row.node : row.itemFieldNode) as LeafNode;
        const v = row.fullPath ? getAt(ctx.parsed, row.fullPath) : undefined;
        lines.push(`{cyan-fg}path{/cyan-fg}     ${escTag(row.fullPath?.join('.') ?? '')}`);
        lines.push(`{cyan-fg}type{/cyan-fg}     ${f.type}`);
        if (f.choices && f.choices.length > 0) {
            lines.push(`{cyan-fg}choices{/cyan-fg}  ${escTag(f.choices.join(', '))}`);
        }
        lines.push(`{cyan-fg}default{/cyan-fg}  ${escTag(formatTomlValue(f.default))}`);
        const cur = v !== undefined ? formatTomlValue(v) : '<unset>';
        const dirtyMark = isDirty(v, f.default) ? ' {yellow-fg}(modified){/yellow-fg}' : '';
        lines.push(`{cyan-fg}current{/cyan-fg}  ${escTag(cur)}${dirtyMark}`);
        if (f.secret) lines.push(`{red-fg}(secret){/red-fg}`);
        if (f.description) {
            lines.push('');
            lines.push(`{white-fg}${escTag(f.description)}{/white-fg}`);
        }

        return lines.join('\n');
    }
    if (row.kind === 'section') {
        const n = row.node as SectionNode;
        lines.push(`{cyan-fg}section{/cyan-fg} ${escTag(n.path.join('.'))}`);
        lines.push(`{cyan-fg}items{/cyan-fg}   ${n.children.length}`);
        if (n.description) lines.push('', `{white-fg}${escTag(n.description)}{/white-fg}`);

        return lines.join('\n');
    }
    if (row.kind === 'collection') {
        const n = row.node as CollectionNode;
        const arr = (getAt(ctx.parsed, n.path) as unknown[] | undefined) ?? [];
        lines.push(`{cyan-fg}collection{/cyan-fg} ${escTag(n.path.join('.'))}`);
        lines.push(`{cyan-fg}items{/cyan-fg}      ${arr.length}`);
        lines.push(`{cyan-fg}fields{/cyan-fg}     ${n.itemFields.map((f) => f.key).join(', ')}`);
        if (n.description) lines.push('', `{white-fg}${escTag(n.description)}{/white-fg}`);

        return lines.join('\n');
    }
    if (row.kind === 'map') {
        const n = row.node as MapNode;
        const m = (getAt(ctx.parsed, n.path) as Record<string, unknown> | undefined) ?? {};
        lines.push(`{cyan-fg}map{/cyan-fg}   ${escTag(n.path.join('.'))}`);
        lines.push(`{cyan-fg}keys{/cyan-fg}  ${Object.keys(m).length}`);
        lines.push(`{cyan-fg}fields{/cyan-fg} ${n.itemFields.map((f) => f.key).join(', ')}`);
        if (n.description) lines.push('', `{white-fg}${escTag(n.description)}{/white-fg}`);

        return lines.join('\n');
    }
    if (row.kind === 'collection-item') {
        return `{cyan-fg}item{/cyan-fg} ${row.itemIndex! + 1} of ${escTag(row.parentCollection!.path.join('.'))}\n\n{gray-fg}enter to expand · d to delete{/gray-fg}`;
    }
    if (row.kind === 'map-entry') {
        return `{cyan-fg}entry{/cyan-fg} ${escTag(row.mapKey!)} of ${escTag(row.parentMap!.path.join('.'))}\n\n{gray-fg}enter to expand · d to delete{/gray-fg}`;
    }
    if (row.kind === 'add-collection') {
        return `{green-fg}Press enter{/green-fg} to add a new item to ${escTag(row.parentCollection!.path.join('.'))}.`;
    }
    if (row.kind === 'add-map') {
        return `{green-fg}Press enter{/green-fg} to add a new entry to ${escTag(row.parentMap!.path.join('.'))}.`;
    }

    return '';
}

function extractTomlSection(text: string, header: string): string {
    const lines = text.split('\n');
    const headerRe = /^\s*\[\[?([^\]]+)\]\]?/;
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const m = headerRe.exec(lines[i]);
        if (!m) continue;
        const h = m[1].trim();
        if (h === header || h.startsWith(`${header}.`) || h === header.split('.').slice(0, -1).join('.')) {
            if (start === -1 && (h === header || h.startsWith(`${header}.`))) start = i;
        }
        if (start !== -1 && i > start) {
            const ml = headerRe.exec(lines[i]);
            if (ml) {
                const hh = ml[1].trim();
                if (!hh.startsWith(`${header}.`) && hh !== header) {
                    end = i;
                    break;
                }
            }
        }
    }
    if (start === -1) return '';

    return lines.slice(start, end).join('\n').replace(/\n+$/, '');
}

function renderTomlPanel(ctx: SettingsCtx, row: TreeRow | undefined): string {
    if (!row) return '';
    let header: string | undefined;
    if (row.kind === 'leaf' && row.node) header = row.node.path.slice(0, -1).join('.');
    else if (row.kind === 'item-leaf' && row.fullPath) {
        const idxOrKey = row.fullPath[row.fullPath.length - 2];
        if (row.parentMap) header = row.parentMap.path.join('.') + '.' + idxOrKey;
        else if (row.parentCollection) header = row.parentCollection.path.join('.');
    } else if (row.kind === 'section' || row.kind === 'collection' || row.kind === 'map') {
        header = (row.node as SectionNode).path.join('.');
    } else if (row.kind === 'collection-item' && row.parentCollection) {
        header = row.parentCollection.path.join('.');
    } else if (row.kind === 'map-entry' && row.parentMap) {
        header = row.parentMap.path.join('.') + '.' + row.mapKey;
    } else if (row.kind === 'add-collection' && row.parentCollection) {
        header = row.parentCollection.path.join('.');
    } else if (row.kind === 'add-map' && row.parentMap) {
        header = row.parentMap.path.join('.');
    }
    if (!header) return '';
    const snippet = extractTomlSection(ctx.text, header);
    if (!snippet) return `{gray-fg}(no entries yet for [${escTag(header)}]){/gray-fg}`;

    return colorizeToml(snippet);
}

function colorizeToml(s: string): string {
    return s
        .split('\n')
        .map((raw) => {
            const line = escTag(raw);
            if (/^\s*#/.test(raw)) return `{gray-fg}${line}{/gray-fg}`;
            const headerMatch = /^\s*(\[\[?[^\]]+\]\]?)/.exec(raw);
            if (headerMatch) {
                return line.replace(escTag(headerMatch[1]), `{magenta-fg}{bold}${escTag(headerMatch[1])}{/bold}{/magenta-fg}`);
            }
            const kv = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$/.exec(raw);
            if (kv) {
                const valuePart = escTag(kv[4]);
                let coloredVal = valuePart;
                if (/^(true|false)\b/.test(kv[4])) coloredVal = `{green-fg}${valuePart}{/green-fg}`;
                else if (/^-?\d/.test(kv[4])) coloredVal = `{yellow-fg}${valuePart}{/yellow-fg}`;
                else if (/^["']/.test(kv[4])) coloredVal = `{cyan-fg}${valuePart}{/cyan-fg}`;

                return `${kv[1]}{white-fg}${kv[2]}{/white-fg}${kv[3]}${coloredVal}`;
            }

            return line;
        })
        .join('\n');
}



async function modalArrayEditor(
    screen: blessed.Widgets.Screen,
    label: string,
    initial: string[],
): Promise<OverlayResult<string[]>> {
    return new Promise((resolve) => {
        const arr = [...initial];
        const box = blessed.box({
            parent: screen,
            label: ` ${label} `,
            top: 'center',
            left: 'center',
            width: '70%',
            height: '70%',
            border: { type: 'line' },
            tags: true,
            style: { border: { fg: 'magenta' }, bg: 'black' },
        });
        const list = blessed.list({
            parent: box,
            top: 0,
            left: 0,
            right: 0,
            bottom: 1,
            keys: true,
            vi: true,
            mouse: true,
            tags: false,
            scrollbar: { ch: ' ', style: { bg: 'magenta' } },
            style: {
                selected: { bg: 'magenta', fg: 'white', bold: true },
                item: { fg: 'white' },
                bg: 'black',
            },
            items: [],
        });
        const hint = blessed.box({
            parent: box,
            bottom: 0,
            left: 1,
            right: 1,
            height: 1,
            tags: true,
            content: '{gray-fg}a add · e edit · d delete · J/K reorder · enter save · esc cancel{/gray-fg}',
        });
        void hint;
        const refresh = (): void => {
            list.setItems(arr.length === 0 ? ['(empty)'] : arr.map((v, i) => `${String(i + 1).padStart(2, ' ')}. ${v}`));
            screen.render();
        };
        const cleanup = (val: string[] | null): void => {
            box.destroy();
            screen.render();
            resolve({ value: val });
        };
        const focusedIdx = (): number => {
            const sel = (list as unknown as { selected: number }).selected;

            return arr.length === 0 ? -1 : sel;
        };
        list.key(['escape'], () => cleanup(null));
        list.key(['enter'], () => cleanup(arr));
         
        list.key(['a'], async () => {
            const r = await modalText(screen, 'Add item', '');
            if (r.value !== null && r.value !== '') {
                arr.push(r.value);
                refresh();
                list.select(arr.length - 1);
                list.focus();
                screen.render();
            } else {
                list.focus();
            }
        });
         
        list.key(['e'], async () => {
            const i = focusedIdx();
            if (i < 0) { list.focus();

 return; }
            const r = await modalText(screen, `Edit item ${i + 1}`, arr[i]);
            if (r.value !== null) {
                arr[i] = r.value;
                refresh();
                list.select(i);
            }
            list.focus();
        });
         
        list.key(['d'], async () => {
            const i = focusedIdx();
            if (i < 0) { list.focus();

 return; }
            const ok = await modalConfirm(screen, 'Delete', `Delete "${arr[i]}"?`);
            if (ok) {
                arr.splice(i, 1);
                refresh();
                list.select(Math.min(i, arr.length - 1));
            }
            list.focus();
        });
        list.key(['S-j'], () => {
            const i = focusedIdx();
            if (i < 0 || i >= arr.length - 1) return;
            [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
            refresh();
            list.select(i + 1);
        });
        list.key(['S-k'], () => {
            const i = focusedIdx();
            if (i <= 0) return;
            [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
            refresh();
            list.select(i - 1);
        });
        refresh();
        list.focus();
        screen.render();
    });
}

function parseScalar(raw: string, type: LeafType): unknown {
    const t = raw.trim();
    if (type === 'bool') return /^(true|yes|y|1|on)$/i.test(t);
    if (type === 'number') {
        const n = Number(t);
        if (Number.isNaN(n)) throw new Error(`"${raw}" is not a number`);

        return n;
    }
    if (type === 'string-array') {
        if (!t) return [];
        if (t.startsWith('[')) {
            const parsed = toml.parse(`x = ${t}`) as { x: unknown };
            if (!Array.isArray(parsed.x)) throw new Error('not an array');

            return parsed.x;
        }

        return t.split(',').map((s) => s.trim()).filter(Boolean);
    }

    return raw;
}

async function ensureUserFileExists(): Promise<void> {
    try { await fs.access(settingsFilePath); }
    catch {
        const example = await fs.readFile(settingsExamplePath, 'utf8');
        await fs.writeFile(settingsFilePath, example, 'utf8');
    }
}

async function reloadCtx(schema: Schema): Promise<SettingsCtx> {
    const text = await fs.readFile(settingsFilePath, 'utf8');
    const parsed = toml.parse(text);

    return { schema, text, parsed };
}

async function persistText(newText: string): Promise<void> {
    validate(newText);
    await fs.writeFile(settingsFilePath, newText, 'utf8');
}
export async function dynamicSettingsDashboard(): Promise<void> {
    await ensureUserFileExists();
    const exampleSrc = await fs.readFile(settingsExamplePath, 'utf8');
    const schema = parseSchema(exampleSrc);
    let ctx = await reloadCtx(schema);

    const screen = createDashboardScreen({ title: 'kra-settings' });

    const expanded = new Set<string>();
    for (const c of schema.children) {
        if (c.kind === 'section') expanded.add(`root/${c.path.join('.')}`);
    }

    const shell = createDashboardShell({
        screen,
        listLabel: 'settings',
        listFocusName: 'tree',
        listWidth: '50%',
        listItems: [],
        listTags: true,
        search: false,
        detailPanels: [
            { label: 'details', focusName: 'details' },
            { label: 'toml', focusName: 'toml' },
        ],
        keymapText: () =>
            `{cyan-fg}tab{/cyan-fg} cycle   ` +
            `{cyan-fg}enter{/cyan-fg} edit/expand   ` +
            `{cyan-fg}h/l{/cyan-fg} collapse/expand   ` +
            `{cyan-fg}space{/cyan-fg} toggle   ` +
            `{cyan-fg}a{/cyan-fg} add   ` +
            `{cyan-fg}d{/cyan-fg} delete   ` +
            `{cyan-fg}r{/cyan-fg} reset   ` +
            `{cyan-fg}/{/cyan-fg} search   ` +
            `{cyan-fg}q{/cyan-fg} quit`,
    });
    const { header, ring } = shell;
    const tree = shell.list;
    const [details, tomlPanel] = shell.detailPanels;

    let rows: TreeRow[] = [];

    function refreshHeader(): void {
        const dirtyCount = rows.filter((r) => r.isDirty).length;
        const dirtyChip = dirtyCount > 0
            ? ` {yellow-fg}● ${dirtyCount} modified{/yellow-fg}`
            : ' {green-fg}● clean{/green-fg}';
        header.setContent(
            ` {magenta-fg}{bold}◆ kra-settings{/bold}{/magenta-fg}` +
            `   {cyan-fg}file{/cyan-fg} {white-fg}${escTag(settingsFilePath)}{/white-fg}` +
            `   {cyan-fg}sections{/cyan-fg} {yellow-fg}${schema.children.length}{/yellow-fg}` +
            dirtyChip,
        );
    }

    function rebuildRows(preserveId?: string): void {
        rows = buildRows(ctx, expanded);
        const items = rows.map((r) => renderRow(r, false));
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
        details.setContent(renderDetails(ctx, row));
        details.setScrollPerc(0);
        tomlPanel.setContent(renderTomlPanel(ctx, row));
        tomlPanel.setScrollPerc(0);
    }

    async function reloadAll(preserveId?: string): Promise<void> {
        ctx = await reloadCtx(schema);
        rebuildRows(preserveId);
    }

    async function applyEdit(mutate: (text: string) => string, preserveId?: string): Promise<void> {
        try {
            const next = mutate(ctx.text);
            await persistText(next);
            await reloadAll(preserveId);
        } catch (e) {
            flash(`error: ${(e as Error).message}`, 'red');
        }
    }

    function flash(msg: string, color = 'green'): void {
        const prev = header.getContent();
        header.setContent(prev + `   {${color}-fg}${escTag(msg)}{/${color}-fg}`);
        screen.render();
        setTimeout(() => { header.setContent(prev); refreshHeader(); screen.render(); }, 1500).unref();
    }

    async function editLeafRow(row: TreeRow): Promise<void> {
        const f = (row.kind === 'leaf' ? row.node : row.itemFieldNode) as LeafNode;
        const path = row.fullPath!;
        const cur = getAt(ctx.parsed, path);
        if (f.type === 'bool') {
            const next = !(cur ?? f.default);
            await applyEdit((t) => setLeaf(t, path, next), row.id);

            return;
        }
        if (f.choices && f.choices.length > 0) {
            const r = await modalChoice(screen, f.label ?? f.key, [...f.choices], typeof cur === 'string' ? cur : undefined);
            if (r.value !== null) await applyEdit((t) => setLeaf(t, path, r.value), row.id);
            tree.focus();

            return;
        }
        if (f.type === 'string-array') {
            const initial = Array.isArray(cur) ? cur.map(String) : Array.isArray(f.default) ? f.default.map(String) : [];
            const r = await modalArrayEditor(screen, f.label ?? f.key, initial);
            if (r.value !== null) await applyEdit((t) => setLeaf(t, path, r.value), row.id);
            tree.focus();

            return;
        }
        const initial = cur === undefined ? '' : (typeof cur === 'string' ? cur : formatTomlValue(cur));
        const r = await modalText(screen, f.label ?? f.key, initial, {
            multiline: f.type === 'string' && initial.length > 60,
        });
        if (r.value !== null) {
            try {
                const value = parseScalar(r.value, f.type);
                await applyEdit((t) => setLeaf(t, path, value), row.id);
            } catch (e) {
                flash(`parse error: ${(e as Error).message}`, 'red');
            }
        }
        tree.focus();
    }

    async function addCollectionFlow(coll: CollectionNode): Promise<void> {
        const values: Record<string, unknown> = {};
        for (const f of coll.itemFields) {
            let raw: string | null = null;
            if (f.choices && f.choices.length > 0) {
                const r = await modalChoice(screen, `${f.label ?? f.key} (${f.key})`, [...f.choices]);
                if (r.value === null) { tree.focus();

 return; }
                values[f.key] = r.value;
                continue;
            }
            const r = await modalText(screen, `${f.label ?? f.key} (${f.key}, ${f.type})`,
                f.default !== undefined ? formatTomlValue(f.default).replace(/^"|"$/g, '') : '');
            raw = r.value;
            if (raw === null) { tree.focus();

 return; }
            try {
                values[f.key] = parseScalar(raw, f.type);
            } catch (e) { flash(`parse error: ${(e as Error).message}`, 'red'); tree.focus();

 return; }
        }
        await applyEdit((t) => addCollectionItem(t, coll.path, values));
        tree.focus();
    }

    async function addMapFlow(m: MapNode): Promise<void> {
        const keyR = await modalText(screen, 'New entry key', '');
        if (!keyR.value?.trim()) { tree.focus();

 return; }
        const key = keyR.value.trim();
        const values: Record<string, unknown> = {};
        for (const f of m.itemFields) {
            if (f.choices && f.choices.length > 0) {
                const r = await modalChoice(screen, `${f.label ?? f.key} (${f.key})`, [...f.choices]);
                if (r.value === null) { tree.focus();

 return; }
                values[f.key] = r.value;
                continue;
            }
            const r = await modalText(screen, `${f.label ?? f.key} (${f.key}, ${f.type})`,
                f.default !== undefined ? formatTomlValue(f.default).replace(/^"|"$/g, '') : '');
            if (r.value === null) { tree.focus();

 return; }
            try {
                values[f.key] = parseScalar(r.value, f.type);
            } catch (e) { flash(`parse error: ${(e as Error).message}`, 'red'); tree.focus();

 return; }
        }
        await applyEdit((t) => addMapItem(t, m.path, key, values));
        tree.focus();
    }

    async function deleteFlow(row: TreeRow): Promise<void> {
        if (row.kind === 'collection-item' && row.parentCollection) {
            const ok = await modalConfirm(screen, 'Delete item',
                `Delete item ${row.itemIndex! + 1} from ${row.parentCollection.path.join('.')}?`);
            if (ok) await applyEdit((t) => removeCollectionItem(t, row.parentCollection!.path, row.itemIndex!));
            tree.focus();

            return;
        }
        if (row.kind === 'map-entry' && row.parentMap) {
            const ok = await modalConfirm(screen, 'Delete entry',
                `Delete entry "${row.mapKey}" from ${row.parentMap.path.join('.')}?`);
            if (ok) await applyEdit((t) => removeMapItem(t, [...row.parentMap!.path, row.mapKey!]));
            tree.focus();

            return;
        }
        flash('nothing to delete here', 'yellow');
    }

    async function resetFlow(row: TreeRow): Promise<void> {
        if (row.kind !== 'leaf' && row.kind !== 'item-leaf') { flash('not a leaf', 'yellow');

 return; }
        const f = (row.kind === 'leaf' ? row.node : row.itemFieldNode) as LeafNode;
        const ok = await modalConfirm(screen, 'Reset to default',
            `Reset ${row.fullPath!.join('.')} to ${formatTomlValue(f.default)}?`);
        if (ok) await applyEdit((t) => setLeaf(t, row.fullPath!, f.default), row.id);
        tree.focus();
    }

    async function searchFlow(): Promise<void> {
        const r = await modalText(screen, 'Search', '');
        if (!r.value) return;
        const q = r.value.toLowerCase();
        const idx = rows.findIndex((row) =>
            (row.fullPath?.join('.').toLowerCase().includes(q) ?? false)
            || row.label.toLowerCase().includes(q),
        );
        if (idx >= 0) {
            tree.select(idx);
            refreshSidePanels();
            screen.render();
        } else {
            flash(`no match for "${r.value}"`, 'yellow');
        }
    }

    tree.on('select item', () => {
        refreshSidePanels();
        screen.render();
    });

     
    tree.key(['enter'], async () => {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        if (!row) return;
        if (toggleExpandedRow(row, expanded, rebuildRows)) {
            return;
        }
        if (row.kind === 'leaf' || row.kind === 'item-leaf') {
            await editLeafRow(row);

            return;
        }
        if (row.kind === 'add-collection' && row.parentCollection) {
            await addCollectionFlow(row.parentCollection);

            return;
        }
        if (row.kind === 'add-map' && row.parentMap) {
            await addMapFlow(row.parentMap);

            return;
        }
    });

     
    tree.key(['space'], async () => {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        if (!row) return;
        const f = (row.kind === 'leaf' ? row.node : row.itemFieldNode) as LeafNode | undefined;
        if (f && f.type === 'bool' && row.fullPath) {
            const cur = getAt(ctx.parsed, row.fullPath);
            await applyEdit((t) => setLeaf(t, row.fullPath!, !(cur ?? f.default)), row.id);
        } else if (toggleExpandedRow(row, expanded, rebuildRows)) {
            return;
        }
    });

     
    tree.key(['a'], async () => {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        if (!row) return;
        if (row.kind === 'collection' && row.node) {
            await addCollectionFlow(row.node as CollectionNode);
        } else if (row.kind === 'map' && row.node) {
            await addMapFlow(row.node as MapNode);
        } else if (row.kind === 'add-collection' && row.parentCollection) {
            await addCollectionFlow(row.parentCollection);
        } else if (row.kind === 'add-map' && row.parentMap) {
            await addMapFlow(row.parentMap);
        } else {
            flash('cannot add here', 'yellow');
        }
    });

     
    tree.key(['d'], async () => {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        if (row) await deleteFlow(row);
    });

     
    tree.key(['r'], async () => {
        const sel = (tree as unknown as { selected: number }).selected;
        const row = rows[sel];
        if (row) await resetFlow(row);
    });

     
    tree.key(['/'], async () => {
        await searchFlow();
        tree.focus();
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
            const cur = (tree as unknown as { selected?: number }).selected ?? 0;
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
