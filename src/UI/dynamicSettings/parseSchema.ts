/**
 * Parses `settings.toml.example` into a Schema tree.
 *
 * Strategy:
 *   1. smol-toml parses the file into a structured object (we use it for
 *      values + type inference).
 *   2. We walk the raw lines to:
 *        a. Match each header `[a.b]` / `[[a.b]]` to its line index and
 *           collect the contiguous comment block above it.
 *        b. Match each `key = value` line inside the active section, capture
 *           its trailing inline comment and the comment block above it.
 *   3. We then build the schema tree, attaching descriptions from
 *      (inline ?? block) for leaves and from (block) for sections.
 *
 * Map detection: a tree node X is treated as a `map` (kind: 'map') when
 *   - it has ≥2 direct table children that are NOT table-arrays, AND
 *   - X itself is never declared as its own [X] header with leaves.
 * This catches `[lsp.<id>]` and `[ai.agent.mcpServers.<name>]` automatically.
 * The annotation `# @map` on any section header forces map detection on the
 * parent path of that header.
 *
 * Collections (table-arrays `[[x]]`) are always classified as `collection`,
 * with item shape derived from the FIRST entry in the file.
 *
 * Limitations:
 *   - Only single-line values are supported (no multi-line array literals).
 *     The example file already follows this convention.
 */

import * as toml from 'smol-toml';
import {
    CollectionNode,
    LeafNode,
    LeafType,
    MapNode,
    Schema,
    SchemaNode,
    SectionNode,
} from '@/UI/dynamicSettings/types';

interface RawLeafEntry {
    path: string[];
    /** Line index (0-based) in the file. */
    lineIndex: number;
    /** Description: trailing inline comment, or block above. */
    description?: string;
    label?: string;
    choices?: string[];
    secret?: boolean;
}

interface RawHeaderEntry {
    /** ['ai','docs','sources']. */
    path: string[];
    /** True if `[[ ... ]]` table-array entry. */
    isArrayItem: boolean;
    lineIndex: number;
    description?: string;
    label?: string;
    /** True if `# @map` was on the header. */
    forceMap?: boolean;
    /** From `# @collection-key: foo`. */
    displayKey?: string;
    /** The leaf entries directly inside this section header (in source order). */
    leaves: RawLeafEntry[];
}

/** Strips keys whose value is `undefined` so object literals satisfy exactOptionalPropertyTypes. */
function prune<T extends Record<string, unknown>>(
    obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
    const out: Record<string, unknown> = {};

    for (const k of Object.keys(obj)) {
        const v = obj[k];

        if (v !== undefined) out[k] = v;
    }

    return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

const HEADER_RE = /^\s*(\[\[?)([^\]]+)\]\]?\s*(?:#.*)?$/;
const KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/;
const MAGIC_LABEL_RE = /@label:\s*([^|@]+?)(?=\s*@|\s*$)/;
const MAGIC_CHOICES_RE = /@choices:\s*([^|@]+?)(?=\s*@|\s*$)/;
const MAGIC_SECRET_RE = /@secret\b/;
const MAGIC_MAP_RE = /@map\b/;
const MAGIC_COLLECTION_KEY_RE = /@collection-key:\s*([A-Za-z0-9_-]+)/;

/** Split a value-line into raw value text + trailing inline comment. */
function splitValueAndComment(rest: string): { rawValue: string; inline?: string } {
    let inString: false | '"' | "'" = false;
    let escape = false;

    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];

        if (inString) {
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString === '"') { escape = true; continue; }
            if (ch === inString) { inString = false; continue; }

            continue;
        }

        if (ch === '"' || ch === "'") { inString = ch; continue; }

        if (ch === '#') {
            return {
                rawValue: rest.slice(0, i).trimEnd(),
                inline: rest.slice(i + 1).trim(),
            };
        }
    }

    return { rawValue: rest.trimEnd() };
}

function stripBoxDrawing(s: string): string {
    return s.replace(/[─━━═]+/g, '').trim();
}

/** Collect the contiguous block of `# ...` lines immediately above `idx`. */
function collectBlockAbove(lines: string[], idx: number): string[] {
    const block: string[] = [];

    for (let i = idx - 1; i >= 0; i--) {
        const line = lines[i];

        if (/^\s*#/.test(line)) {
            block.unshift(line.replace(/^\s*#\s?/, ''));
        } else if (line.trim() === '') {
            // Blank line stops the block (one blank line tolerated only between
            // header banners — we keep it simple).
            break;
        } else {
            break;
        }
    }

    return block;
}

/** Pretty title for a section/leaf when no @label is provided. */
function prettifyKey(key: string): string {
    return key
        .replace(/[._-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^\w/, (c) => c.toUpperCase());
}

/** Infer leaf type from its parsed value. */
function inferLeafType(value: unknown): LeafType {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number' || typeof value === 'bigint') return 'number';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) {
        if (value.every((v) => typeof v === 'string')) return 'string-array';
    }

    return 'unknown';
}

function extractMagic(comment: string | undefined): {
    description?: string;
    label?: string;
    choices?: string[];
    secret?: boolean;
    forceMap?: boolean;
    collectionKey?: string;
} {
    if (!comment) return {};

    let remaining = comment;
    const out: ReturnType<typeof extractMagic> = {};

    const labelMatch = MAGIC_LABEL_RE.exec(remaining);
    if (labelMatch) {
        out.label = labelMatch[1].trim();
        remaining = remaining.replace(labelMatch[0], '').trim();
    }

    const choicesMatch = MAGIC_CHOICES_RE.exec(remaining);
    if (choicesMatch) {
        out.choices = choicesMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
        remaining = remaining.replace(choicesMatch[0], '').trim();
    }

    if (MAGIC_SECRET_RE.test(remaining)) {
        out.secret = true;
        remaining = remaining.replace(MAGIC_SECRET_RE, '').trim();
    }

    if (MAGIC_MAP_RE.test(remaining)) {
        out.forceMap = true;
        remaining = remaining.replace(MAGIC_MAP_RE, '').trim();
    }

    const ckMatch = MAGIC_COLLECTION_KEY_RE.exec(remaining);
    if (ckMatch) {
        out.collectionKey = ckMatch[1];
        remaining = remaining.replace(ckMatch[0], '').trim();
    }

    const desc = remaining.replace(/[|;,]\s*$/, '').trim();
    if (desc.length > 0) out.description = desc;

    return out;
}

function descriptionFromBlock(block: string[]): string | undefined {
    if (block.length === 0) return undefined;
    const cleaned = block
        .map((line) => stripBoxDrawing(line))
        .filter((line) => line.length > 0)
        .join('\n')
        .trim();

    return cleaned || undefined;
}

/** Walks the file and produces a flat list of header entries with their leaves. */
function tokenizeRawHeaders(src: string): RawHeaderEntry[] {
    const lines = src.split('\n');
    const headers: RawHeaderEntry[] = [];
    let current: RawHeaderEntry | null = null;

    // Implicit root section (for keys before any header — none in our file, but handle it).
    const root: RawHeaderEntry = {
        path: [],
        isArrayItem: false,
        lineIndex: -1,
        leaves: [],
    };
    current = root;
    headers.push(root);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === '' || /^\s*#/.test(line)) continue;

        const headerMatch = HEADER_RE.exec(line);
        if (headerMatch) {
            const isArrayItem = headerMatch[1] === '[[';
            const segs = headerMatch[2].split('.').map((s) => s.trim()).filter(Boolean);
            const block = collectBlockAbove(lines, i);
            const blockDesc = descriptionFromBlock(block);
            // Magic on the header line itself
            const lineCommentMatch = /#(.*)$/.exec(line);
            const inlineMagic = lineCommentMatch
                ? extractMagic(lineCommentMatch[1].trim())
                : {};

            const entry = prune({
                path: segs,
                isArrayItem,
                lineIndex: i,
                description: inlineMagic.description ?? blockDesc,
                label: inlineMagic.label,
                forceMap: inlineMagic.forceMap,
                displayKey: inlineMagic.collectionKey,
                leaves: [],
            });

            headers.push(entry);
            current = entry;
            continue;
        }

        const keyMatch = KEY_RE.exec(line);
        if (keyMatch) {
            const key = keyMatch[1];
            const { inline } = splitValueAndComment(keyMatch[2]);
            const block = collectBlockAbove(lines, i);
            const blockDesc = descriptionFromBlock(block);
            const inlineMagic = extractMagic(inline);

            current.leaves.push(prune({
                path: [...current.path, key],
                lineIndex: i,
                description: inlineMagic.description ?? blockDesc,
                label: inlineMagic.label,
                choices: inlineMagic.choices,
                secret: inlineMagic.secret,
            }));
        }
    }

    return headers;
}

/** Look up a value at a dotted path inside a parsed TOML object. */
function getAt(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;

    for (const seg of path) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }

    return cur;
}

/** First-entry helper for table-arrays. */
function firstArrayItem(parsed: unknown, path: string[]): Record<string, unknown> | undefined {
    const arr = getAt(parsed, path);
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const first = arr[0] as unknown;

    return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
}

/** Build a leaf node from a raw entry + parsed default value. */
function makeLeaf(raw: RawLeafEntry, defaultValue: unknown): LeafNode {
    const type = inferLeafType(defaultValue);

    return prune({
        kind: 'leaf',
        path: raw.path,
        key: raw.path[raw.path.length - 1],
        type,
        default: defaultValue,
        description: raw.description,
        label: raw.label,
        choices: raw.choices,
        secret: raw.secret,
    }) as LeafNode;
}

/** Recursive container builder. */
function buildContainerChildren(
    parsedRoot: unknown,
    nodeChildren: TreeNode[],
    forceMapPaths: Set<string>,
): SchemaNode[] {
    const out: SchemaNode[] = [];

    for (const child of nodeChildren) {
        const node = buildNode(parsedRoot, child, forceMapPaths);
        if (node) out.push(node);
    }

    return out;
}

interface TreeNode {
    segment: string;
    path: string[];
    /** The header entry that owns this exact path, if any. */
    header?: RawHeaderEntry;
    /** Direct child segments. */
    children: Map<string, TreeNode>;
    /** Child indices that are table-array headers (siblings sharing the same path). */
    arrayHeaders: RawHeaderEntry[];
}

function ensureChild(parent: TreeNode, segment: string): TreeNode {
    let child = parent.children.get(segment);
    if (!child) {
        child = {
            segment,
            path: [...parent.path, segment],
            children: new Map(),
            arrayHeaders: [],
        };
        parent.children.set(segment, child);
    }

    return child;
}

function buildTree(headers: RawHeaderEntry[]): TreeNode {
    const root: TreeNode = {
        segment: '',
        path: [],
        children: new Map(),
        arrayHeaders: [],
    };

    for (const h of headers) {
        if (h.path.length === 0) continue;

        let cursor = root;

        for (const seg of h.path) {
            cursor = ensureChild(cursor, seg);
        }

        if (h.isArrayItem) {
            cursor.arrayHeaders.push(h);
        } else {
            cursor.header = h;
        }
    }

    return root;
}

function buildNode(
    parsedRoot: unknown,
    node: TreeNode,
    forceMapPaths: Set<string>,
): SchemaNode | null {
    const pathKey = node.path.join('.');

    // Collection: table-array siblings under this exact path.
    if (node.arrayHeaders.length > 0) {
        const tmpl = node.arrayHeaders[0];
        const firstItem = firstArrayItem(parsedRoot, node.path);
        const itemFields: LeafNode[] = tmpl.leaves.map((leaf) =>
            makeLeaf(leaf, firstItem ? firstItem[leaf.path[leaf.path.length - 1]] : undefined),
        );

        const displayKey = tmpl.displayKey
            ?? (itemFields.find((f) => f.key === 'alias') ? 'alias' : undefined)
            ?? (itemFields.find((f) => f.key === 'name') ? 'name' : undefined)
            ?? itemFields.find((f) => f.type === 'string')?.key;

        return prune({
            kind: 'collection',
            path: node.path,
            title: prettifyKey(node.segment),
            label: tmpl.label,
            description: tmpl.description,
            itemFields,
            itemSections: [],
            displayKey,
        }) as CollectionNode;
    }

    const childForcedMap = Array.from(node.children.values()).some(
        (c) => c.header?.forceMap === true,
    );
    // Map auto-detect: ≥2 sibling children with no own header, no nested
    // sub-children, and IDENTICAL leaf-key signatures (the hallmark of a
    // user-extensible map like [lsp.*] or [ai.agent.mcpServers.*]).
    const allChildren = Array.from(node.children.values());
    const sigsLookSimilar = (() => {
        if (allChildren.length < 2) return false;
        if (!allChildren.every((c) => c.arrayHeaders.length === 0)) return false;
        if (!allChildren.every((c) => c.children.size === 0)) return false;
        if (!allChildren.every((c) => !!c.header)) return false;
        const sig = (c: TreeNode): string =>
            (c.header?.leaves.map((l) => l.path[l.path.length - 1]).sort().join(',')) ?? '';
        const first = sig(allChildren[0]);
        if (!first) return false;

        return allChildren.every((c) => sig(c) === first);
    })();

    const isMap =
        forceMapPaths.has(pathKey)
        || childForcedMap
        || (!node.header && sigsLookSimilar);

    if (isMap && node.children.size > 0) {
        const firstChildEntry = Array.from(node.children.values())[0];
        const firstChildHeader = firstChildEntry.header;
        const parsedFirstItem = getAt(parsedRoot, firstChildEntry.path) as
            | Record<string, unknown>
            | undefined;

        const itemFields: LeafNode[] = (firstChildHeader?.leaves ?? []).map((leaf) =>
            makeLeaf(leaf, parsedFirstItem ? parsedFirstItem[leaf.path[leaf.path.length - 1]] : undefined),
        );

        const itemSections: SectionNode[] = [];
        for (const sub of firstChildEntry.children.values()) {
            const built = buildNode(parsedRoot, sub, forceMapPaths);
            if (built && built.kind === 'section') itemSections.push(built);
        }

        return prune({
            kind: 'map',
            path: node.path,
            title: prettifyKey(node.segment),
            label: node.header?.label,
            description: node.header?.description,
            itemFields,
            itemSections,
        }) as MapNode;
    }

    // Plain section.
    const childNodes: SchemaNode[] = [];

    if (node.header) {
        for (const leaf of node.header.leaves) {
            const value = getAt(parsedRoot, leaf.path);

            childNodes.push(makeLeaf(leaf, value));
        }
    }

    for (const child of node.children.values()) {
        const built = buildNode(parsedRoot, child, forceMapPaths);

        if (built) childNodes.push(built);
    }

    if (childNodes.length === 0 && !node.header) {
        return null;
    }

    return prune({
        kind: 'section',
        path: node.path,
        title: prettifyKey(node.segment),
        label: node.header?.label,
        description: node.header?.description,
        children: childNodes,
    }) as SectionNode;
}

/** Public: parse the example file source into a Schema tree. */
export function parseSchema(exampleSrc: string): Schema {
    const headers = tokenizeRawHeaders(exampleSrc);
    const tree = buildTree(headers);
    const parsed = toml.parse(exampleSrc);

    // forceMapPaths: parent of any header that has @map.
    const forceMapPaths = new Set<string>();
    for (const h of headers) {
        if (h.forceMap && h.path.length > 0) {
            forceMapPaths.add(h.path.slice(0, -1).join('.'));
        }
    }

    const children: SchemaNode[] = [];
    for (const child of tree.children.values()) {
        const built = buildNode(parsed, child, forceMapPaths);
        if (built) children.push(built);
    }

    return { children };
}

// Silence "buildContainerChildren is unused" — kept for future nested expansion needs.
void buildContainerChildren;
