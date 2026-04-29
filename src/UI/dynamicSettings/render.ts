/**
 * Dynamic blessed UI for `~/.kra/settings.toml`. Driven entirely by the
 * schema parsed from `settings.toml.example` — adding a new key to the
 * example file makes it appear here automatically.
 */

import * as fs from 'fs/promises';
import * as toml from 'smol-toml';
import * as ui from '@/UI/generalUI';
import { menuChain, UserCancelled } from '@/UI/menuChain';
import { openVim } from '@/utils/neovimHelper';
import { settingsFilePath } from '@/filePaths';
import { settingsExamplePath } from '@/packagePaths';
import { parseSchema } from './parseSchema';
import {
    addCollectionItem,
    addMapItem,
    formatTomlValue,
    removeCollectionItem,
    removeMapItem,
    setLeaf,
    validate,
} from './rewriter';
import type {
    CollectionNode,
    LeafNode,
    LeafType,
    MapNode,
    SchemaNode,
    SectionNode,
} from './types';

function getAt(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;
    for (const seg of path) {
        if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
    }

    return cur;
}

async function readUserText(): Promise<string> {
    try {
        return await fs.readFile(settingsFilePath, 'utf8');
    } catch {
        return '';
    }
}

async function readParsed(): Promise<unknown> {
    const text = await readUserText();
    if (!text.trim()) return {};
    try {
        return toml.parse(text);
    } catch {
        return {};
    }
}

async function persist(newText: string): Promise<void> {
    validate(newText);
    await fs.writeFile(settingsFilePath, newText, 'utf8');
}

function nodeLabel(n: SchemaNode): string {
    switch (n.kind) {
        case 'leaf': return n.label ?? n.key;
        case 'section': return n.label ?? n.title;
        case 'collection':
        case 'map': return n.label ?? n.title;
    }
}

function previewLeaf(value: unknown, n: LeafNode): string {
    if (value === undefined) value = n.default;
    if (n.secret && value !== undefined && value !== '') return '********';
    if (Array.isArray(value)) return `[${value.length}]`;
    if (typeof value === 'string') return value.length > 50 ? value.slice(0, 47) + '...' : value;
    if (value === undefined) return '<unset>';

    return String(value);
}

function rowFor(n: SchemaNode, parsed: unknown): string {
    const label = nodeLabel(n);
    if (n.kind === 'leaf') {
        const v = getAt(parsed, n.path);

        return `${label}  =  ${previewLeaf(v, n)}`;
    }
    if (n.kind === 'collection') {
        const arr = getAt(parsed, n.path);
        const count = Array.isArray(arr) ? arr.length : 0;

        return `${label}  [${count} item${count === 1 ? '' : 's'}]`;
    }
    if (n.kind === 'map') {
        const m = getAt(parsed, n.path);
        const count = m && typeof m === 'object' ? Object.keys(m).length : 0;

        return `${label}  {${count} entr${count === 1 ? 'y' : 'ies'}}`;
    }

    return `${label}  ▸`;
}

// ============================================================================
// Leaf editor
// ============================================================================

function parseInput(raw: string, type: LeafType): unknown {
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

// ============================================================================
// String-array editor (per-item add/edit/delete/reorder)
// ============================================================================

async function editStringArrayLeaf(node: LeafNode, current: unknown): Promise<void> {
    const initial: string[] = Array.isArray(current)
        ? current.map((v) => String(v))
        : Array.isArray(node.default) ? node.default.map((v) => String(v)) : [];
    let arr = [...initial];
    let dirty = false;

    const SAVE = '✔ Save & back';
    const DISCARD = '✕ Discard changes';
    const ADD = '+ Add item';
    const CLEAR = '- Clear all';

    while (true) {
        const labels = arr.map((v, i) => `${String(i + 1).padStart(2, ' ')}. ${v}`);
        const items = [...labels, ADD];
        if (arr.length > 0) items.push(CLEAR);
        items.push(SAVE, DISCARD);

        const promptTitle = `${node.label ?? node.key}${dirty ? ' *' : ''}`;
        let picked: string | null;
        try {
            picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: items,
                prompt: promptTitle,
            });
        } catch (e) {
            if (e instanceof UserCancelled) return;
            throw e;
        }

        if (!picked || picked === DISCARD) return;

        if (picked === SAVE) {
            const text = await readUserText();
            const next = setLeaf(text, node.path, arr);
            await persist(next);

            return;
        }

        if (picked === ADD) {
            try {
                const v = await ui.askUserForInput(`Add item to ${node.key}:`);
                if (v) { arr.push(v); dirty = true; }
            } catch (e) {
                if (!(e instanceof UserCancelled)) throw e;
            }
            continue;
        }

        if (picked === CLEAR) {
            try {
                const yes = await ui.promptUserYesOrNo(`Clear all ${arr.length} items?`);
                if (yes) { arr = []; dirty = true; }
            } catch (e) {
                if (!(e instanceof UserCancelled)) throw e;
            }
            continue;
        }

        const idx = labels.indexOf(picked);
        if (idx < 0) continue;

        let action: string | null;
        try {
            action = await ui.searchSelectAndReturnFromArray({
                itemsArray: ['Edit', 'Delete', 'Move up', 'Move down', '← Cancel'],
                prompt: `[${idx + 1}] ${arr[idx]}`,
            });
        } catch (e) {
            if (e instanceof UserCancelled) continue;
            throw e;
        }
        if (!action || action === '← Cancel') continue;

        try {
            if (action === 'Edit') {
                const v = await ui.askUserForInput(`Edit (current: ${arr[idx]}):`);
                if (v) { arr[idx] = v; dirty = true; }
            } else if (action === 'Delete') {
                const yes = await ui.promptUserYesOrNo(`Delete "${arr[idx]}"?`);
                if (yes) { arr.splice(idx, 1); dirty = true; }
            } else if (action === 'Move up' && idx > 0) {
                [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
                dirty = true;
            } else if (action === 'Move down' && idx < arr.length - 1) {
                [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                dirty = true;
            }
        } catch (e) {
            if (!(e instanceof UserCancelled)) throw e;
        }
    }
}
async function editLeaf(node: LeafNode, current: unknown): Promise<void> {
    const text = await readUserText();
    const desc = node.description ? `\n\n${node.description}` : '';
    const def = node.default !== undefined ? `\nDefault: ${formatTomlValue(node.default)}` : '';
    const cur = `Current: ${previewLeaf(current, node)}`;

    if (node.choices && node.choices.length > 0) {
        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: [...node.choices],
            prompt: node.label ?? node.key,
        });
        if (!picked) throw new UserCancelled();
        const next = setLeaf(text, node.path, picked);
        await persist(next);

        return;
    }

    if (node.type === 'bool') {
        const yes = await ui.promptUserYesOrNo(
            `${node.label ?? node.key}${desc}\n\n${cur}${def}\n\nEnable?`,
        );
        const next = setLeaf(text, node.path, yes);
        await persist(next);

        return;
    }

    if (node.type === 'string-array') {
        await editStringArrayLeaf(node, current);

        return;
    }

    const prompt =
        `${node.label ?? node.key}${desc}\n\n${cur}${def}\n\n`
        + `New value (${node.type}):`;

    const raw = await ui.askUserForInput(prompt);
    if (raw === '' && node.type !== 'string') throw new UserCancelled();
    const value = parseInput(raw, node.type);
    const next = setLeaf(text, node.path, value);
    await persist(next);
}

// ============================================================================
// Section navigation
// ============================================================================

async function navigateSection(node: SectionNode | { kind: 'root'; children: SchemaNode[]; title: string }): Promise<void> {
    while (true) {
        const parsed = await readParsed();
        const labelToChild = new Map<string, SchemaNode>();
        const items: string[] = [];

        for (const child of node.children) {
            const row = rowFor(child, parsed);
            items.push(row);
            labelToChild.set(row, child);
        }

        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: node.kind === 'root' ? 'kra-settings' : (('title' in node && node.title) || 'Section'),
        });

        if (!picked) {
            if (node.kind === 'root') return;
            throw new UserCancelled();
        }

        const child = labelToChild.get(picked);
        if (!child) continue;

        try {
            await dispatchNode(child, parsed);
        } catch (e) {
            if (!(e instanceof UserCancelled)) throw e;
        }
    }
}

async function dispatchNode(child: SchemaNode, parsed: unknown): Promise<void> {
    if (child.kind === 'leaf') {
        await editLeaf(child, getAt(parsed, child.path));
    } else if (child.kind === 'section') {
        await navigateSection(child);
    } else if (child.kind === 'collection') {
        await navigateCollection(child);
    } else if (child.kind === 'map') {
        await navigateMap(child);
    }
}

// ============================================================================
// Collection
// ============================================================================

function itemDisplay(item: Record<string, unknown>, displayKey: string | undefined, fields: LeafNode[]): string {
    if (displayKey && item[displayKey] !== undefined) return String(item[displayKey]);
    const first = fields.find((f) => f.type === 'string' && item[f.key] !== undefined);
    if (first) return String(item[first.key]);

    return '<item>';
}

async function navigateCollection(node: CollectionNode): Promise<void> {
    while (true) {
        const parsed = await readParsed();
        const arr = (getAt(parsed, node.path) as Record<string, unknown>[] | undefined) ?? [];
        const labels = arr.map((item, i) => `${i + 1}. ${itemDisplay(item, node.displayKey, node.itemFields)}`);
        const items = [...labels, '+ Add new', '- Delete...'];

        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: node.title,
        });

        if (!picked) throw new UserCancelled();

        if (picked === '+ Add new') {
            await collectionAddFlow(node);
            continue;
        }
        if (picked === '- Delete...') {
            await collectionDeleteFlow(node, arr, labels);
            continue;
        }

        const idx = labels.indexOf(picked);
        if (idx >= 0) {
            try { await editCollectionItem(node, idx, arr[idx]); }
            catch (e) { if (!(e instanceof UserCancelled)) throw e; }
        }
    }
}

async function collectionAddFlow(node: CollectionNode): Promise<void> {
    const values: Record<string, unknown> = {};
    for (const field of node.itemFields) {
        const desc = field.description ? `\n\n${field.description}` : '';
        const def = field.default !== undefined ? `\nDefault: ${formatTomlValue(field.default)}` : '';
        if (field.choices && field.choices.length > 0) {
            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...field.choices],
                prompt: field.label ?? field.key,
            });
            if (!picked) return;
            values[field.key] = picked;
        } else if (field.type === 'bool') {
            values[field.key] = await ui.promptUserYesOrNo(`${field.label ?? field.key}${desc}${def}\n\nEnable?`);
        } else {
            const raw = await ui.askUserForInput(`${field.label ?? field.key}${desc}${def}\n\nValue (${field.type}):`);
            try { values[field.key] = parseInput(raw, field.type); }
            catch { values[field.key] = raw; }
        }
    }

    const text = await readUserText();
    const next = addCollectionItem(text, node.path, values);
    await persist(next);
}

async function collectionDeleteFlow(
    node: CollectionNode,
    arr: Record<string, unknown>[],
    labels: string[],
): Promise<void> {
    if (arr.length === 0) {
        await ui.showInfoScreen('Empty', 'Nothing to delete.');

        return;
    }
    const picked = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...labels],
        prompt: 'Delete which?',
    });
    if (!picked) return;
    const idx = labels.indexOf(picked);
    if (idx < 0) return;
    const yes = await ui.promptUserYesOrNo(`Delete "${picked}"?`);
    if (!yes) return;

    const text = await readUserText();
    const next = removeCollectionItem(text, node.path, idx);
    await persist(next);
}

async function editCollectionItem(
    node: CollectionNode,
    index: number,
    item: Record<string, unknown>,
): Promise<void> {
    while (true) {
        const items = node.itemFields.map((f) => `${f.label ?? f.key}  =  ${previewLeaf(item[f.key], f)}`);
        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: `Item ${index + 1}`,
        });
        if (!picked) return;
        const fieldIdx = items.indexOf(picked);
        const field = node.itemFields[fieldIdx];
        if (!field) return;
        const itemPath = [...node.path, String(index), field.key];
        try {
            const next: LeafNode = { ...field, path: itemPath };
            await editLeaf(next, item[field.key]);
        } catch (e) {
            if (!(e instanceof UserCancelled)) throw e;
        }

        // Refresh item from disk.
        const parsed = await readParsed();
        const arr = getAt(parsed, node.path) as Record<string, unknown>[] | undefined;
        if (!arr?.[index]) return;
        item = arr[index];
    }
}

// ============================================================================
// Map
// ============================================================================

async function navigateMap(node: MapNode): Promise<void> {
    while (true) {
        const parsed = await readParsed();
        const raw = getAt(parsed, node.path);
        const m: Record<string, Record<string, unknown>> = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown>>;
        const keys = Object.keys(m);
        const items = [...keys, '+ Add new', '- Delete...'];

        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: node.title,
        });

        if (!picked) throw new UserCancelled();

        if (picked === '+ Add new') {
            await mapAddFlow(node);
            continue;
        }
        if (picked === '- Delete...') {
            await mapDeleteFlow(node, keys);
            continue;
        }

        if (keys.includes(picked)) {
            try { await editMapEntry(node, picked, m[picked] ?? {}); }
            catch (e) { if (!(e instanceof UserCancelled)) throw e; }
        }
    }
}

async function mapAddFlow(node: MapNode): Promise<void> {
    const key = (await ui.askUserForInput('New entry key/name:')).trim();
    if (!key) return;
    const values: Record<string, unknown> = {};
    for (const field of node.itemFields) {
        const desc = field.description ? `\n\n${field.description}` : '';
        const def = field.default !== undefined ? `\nDefault: ${formatTomlValue(field.default)}` : '';
        if (field.choices && field.choices.length > 0) {
            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...field.choices],
                prompt: field.label ?? field.key,
            });
            if (!picked) return;
            values[field.key] = picked;
        } else if (field.type === 'bool') {
            values[field.key] = await ui.promptUserYesOrNo(`${field.label ?? field.key}${desc}${def}\n\nEnable?`);
        } else {
            const raw = await ui.askUserForInput(`${field.label ?? field.key}${desc}${def}\n\nValue (${field.type}):`);
            try { values[field.key] = parseInput(raw, field.type); }
            catch { values[field.key] = raw; }
        }
    }

    const text = await readUserText();
    const next = addMapItem(text, node.path, key, values);
    await persist(next);
}

async function mapDeleteFlow(node: MapNode, keys: string[]): Promise<void> {
    if (keys.length === 0) {
        await ui.showInfoScreen('Empty', 'Nothing to delete.');

        return;
    }
    const picked = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...keys],
        prompt: 'Delete which?',
    });
    if (!picked) return;
    const yes = await ui.promptUserYesOrNo(`Delete "${picked}"?`);
    if (!yes) return;

    const text = await readUserText();
    const next = removeMapItem(text, [...node.path, picked]);
    await persist(next);
}

async function editMapEntry(
    node: MapNode,
    key: string,
    item: Record<string, unknown>,
): Promise<void> {
    while (true) {
        const items = node.itemFields.map((f) => `${f.label ?? f.key}  =  ${previewLeaf(item[f.key], f)}`);
        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: key,
        });
        if (!picked) return;
        const fieldIdx = items.indexOf(picked);
        const field = node.itemFields[fieldIdx];
        if (!field) return;
        const fullPath = [...node.path, key, field.key];
        try {
            const next: LeafNode = { ...field, path: fullPath };
            await editLeaf(next, item[field.key]);
        } catch (e) {
            if (!(e instanceof UserCancelled)) throw e;
        }

        const parsed = await readParsed();
        const m = getAt(parsed, [...node.path, key]) as Record<string, unknown> | undefined;
        if (!m) return;
        item = m;
    }
}

// ============================================================================
// Entry
// ============================================================================

async function ensureUserFileExists(): Promise<void> {
    try {
        await fs.access(settingsFilePath);
    } catch {
        const example = await fs.readFile(settingsExamplePath, 'utf8');
        await fs.writeFile(settingsFilePath, example, 'utf8');
    }
}

export async function runDynamicSettings(): Promise<void> {
    await ensureUserFileExists();
    const exampleSrc = await fs.readFile(settingsExamplePath, 'utf8');
    const schema = parseSchema(exampleSrc);


    await menuChain()
        .step('action', async () => {
            const top = [
                ...schema.children.map(nodeLabel),
                'Edit raw in vim',
            ];
            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: top,
                prompt: 'kra-settings',
            });
            if (!picked) throw new UserCancelled();

            return picked;
        })
        .step('_', async ({ action }) => {
            if (action === 'Edit raw in vim') {
                await openVim(settingsFilePath);
                throw new UserCancelled();
            }

            const child = schema.children.find((c) => nodeLabel(c) === action);
            if (!child) throw new UserCancelled();

            const parsed = await readParsed();
            try {
                await dispatchNode(child, parsed);
            } catch (e) {
                if (!(e instanceof UserCancelled)) throw e;
            }
            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}
