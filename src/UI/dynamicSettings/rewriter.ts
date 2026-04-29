import * as toml from 'smol-toml';

/**
 * Line-aware TOML mutator. Operates on raw file text so comments and
 * formatting are preserved. Only mutates the portions it must.
 *
 * Limitations:
 *  - Assumes single-line value literals (no multi-line array/inline-table
 *    spanning physical lines). The example file follows this convention.
 */

const HEADER_RE = /^\s*\[(\[?)([^\]]+)\]?\]\s*(?:#.*)?$/;
const KEY_RE = /^(\s*)([A-Za-z_][\w-]*)(\s*=\s*)(.*)$/;

function joinPath(p: string[]): string {
    return p.map((s) => (/^[A-Za-z_][\w-]*$/.test(s) ? s : `"${s}"`)).join('.');
}

function parseHeaderLine(line: string): { isArray: boolean; path: string[] } | null {
    const m = HEADER_RE.exec(line);
    if (!m) return null;

    return { isArray: m[1] === '[', path: m[2].trim().split('.').map((s) => s.trim().replace(/^"|"$/g, '')) };
}

/** Split an inline value like `"foo" # comment` into [value, commentSuffix]. */
function splitValueAndComment(rest: string): { value: string; commentSuffix: string } {
    let inStr = false;
    let strCh = '';
    let escape = false;

    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];

        if (escape) { escape = false; continue; }

        if (inStr) {
            if (ch === '\\') { escape = true; continue; }
            if (ch === strCh) inStr = false;
            continue;
        }

        if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }

        if (ch === '#') {
            return { value: rest.slice(0, i).trimEnd(), commentSuffix: ' ' + rest.slice(i).trimEnd() };
        }
    }

    return { value: rest.trimEnd(), commentSuffix: '' };
}

/** Format any JS value as a TOML literal (single-line). */
export function formatTomlValue(value: unknown): string {
    if (value === null || value === undefined) return '""';

    if (typeof value === 'boolean') return value ? 'true' : 'false';

    if (typeof value === 'number') return String(value);

    if (typeof value === 'string') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return '[' + value.map(formatTomlValue).join(', ') + ']';
    }

    // Inline table fallback.
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => `${k} = ${formatTomlValue(v)}`);

        return `{ ${entries.join(', ')} }`;
    }

    return JSON.stringify(String(value));
}

interface Block {
    /** Header line index (0-based). null for the implicit root block. */
    headerIndex: number | null;
    /** First content line index (after header). */
    startIndex: number;
    /** Last content line index (inclusive). */
    endIndex: number;
    isArray: boolean;
    path: string[];
}

/** Walk the file and return all blocks (including implicit root). */
function indexBlocks(lines: string[]): Block[] {
    const blocks: Block[] = [];

    let cur: Block = {
        headerIndex: null,
        startIndex: 0,
        endIndex: lines.length - 1,
        isArray: false,
        path: [],
    };

    for (let i = 0; i < lines.length; i++) {
        const h = parseHeaderLine(lines[i]);
        if (!h) continue;
        cur.endIndex = i - 1;
        blocks.push(cur);
        cur = {
            headerIndex: i,
            startIndex: i + 1,
            endIndex: lines.length - 1,
            isArray: h.isArray,
            path: h.path,
        };
    }

    blocks.push(cur);

    return blocks;
}

/** Find the unique block whose header path matches (and isArray matches). */
function findBlock(blocks: Block[], path: string[], isArray: boolean): Block | undefined {
    return blocks.find(
        (b) => b.headerIndex !== null
            && b.isArray === isArray
            && b.path.length === path.length
            && b.path.every((s, i) => s === path[i]),
    );
}

/** Find all blocks whose header path matches and isArray matches. */
function findBlocks(blocks: Block[], path: string[], isArray: boolean): Block[] {
    return blocks.filter(
        (b) => b.headerIndex !== null
            && b.isArray === isArray
            && b.path.length === path.length
            && b.path.every((s, i) => s === path[i]),
    );
}

/** Find any block matching path (array or table). */
function findAnyBlock(blocks: Block[], path: string[]): Block | undefined {
    return blocks.find(
        (b) => b.headerIndex !== null
            && b.path.length === path.length
            && b.path.every((s, i) => s === path[i]),
    );
}

/**
 * Set a leaf value. Path is the full dotted path (e.g. ['ai', 'global', 'model']).
 * The leaf's owning section header is path.slice(0, -1); the leaf key is path[-1].
 * If the leaf line doesn't exist in the matching block, it's appended.
 */
export function setLeaf(text: string, path: string[], newValue: unknown): string {
    if (path.length === 0) throw new Error('setLeaf: empty path');

    const lines = text.split('\n');
    const blocks = indexBlocks(lines);
    const sectionPath = path.slice(0, -1);
    const key = path[path.length - 1];

    const block = sectionPath.length === 0
        ? blocks.find((b) => b.path.length === 0)
        : findBlock(blocks, sectionPath, false);

    if (!block) {
        // Section doesn't exist — append a new section + key.
        const header = sectionPath.length > 0 ? `\n[${joinPath(sectionPath)}]` : '';
        const out = lines.slice();

        if (header) out.push(header);

        out.push(`${key} = ${formatTomlValue(newValue)}`);

        return out.join('\n');
    }

    for (let i = block.startIndex; i <= block.endIndex; i++) {
        const m = KEY_RE.exec(lines[i]);

        if (!m || m[2] !== key) continue;

        const { commentSuffix } = splitValueAndComment(m[4]);

        lines[i] = `${m[1]}${m[2]}${m[3]}${formatTomlValue(newValue)}${commentSuffix}`;

        return lines.join('\n');
    }

    // Key not present — insert at end of block (before trailing blank lines).
    let insertAt = block.endIndex + 1;

    while (insertAt - 1 > block.startIndex && lines[insertAt - 1].trim() === '') insertAt--;

    lines.splice(insertAt, 0, `${key} = ${formatTomlValue(newValue)}`);

    return lines.join('\n');
}

/**
 * Append a new `[[path]]` table-array entry with the given field values.
 * If at least one entry already exists, it is used as a comment template
 * (we copy it verbatim then overwrite each field's value).
 */
export function addCollectionItem(
    text: string,
    path: string[],
    values: Record<string, unknown>,
): string {
    const lines = text.split('\n');
    const blocks = indexBlocks(lines);
    const existing = findBlocks(blocks, path, true);
    const headerLine = `[[${joinPath(path)}]]`;

    if (existing.length === 0) {
        const out = lines.slice();

        if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');

        out.push(headerLine);

        for (const [k, v] of Object.entries(values)) {
            out.push(`${k} = ${formatTomlValue(v)}`);
        }

        return out.join('\n');
    }

    const tmpl = existing[0];
    const tmplStart = tmpl.headerIndex ?? -1;
    let tmplEnd = tmpl.endIndex;

    while (tmplEnd > tmpl.startIndex && lines[tmplEnd].trim() === '') tmplEnd--;

    const tmplLines = lines.slice(tmplStart, tmplEnd + 1).map((l) => l);

    tmplLines[0] = headerLine;

    for (let i = 1; i < tmplLines.length; i++) {
        const m = KEY_RE.exec(tmplLines[i]);

        if (!m) continue;

        const k = m[2];

        if (!(k in values)) continue;

        const { commentSuffix } = splitValueAndComment(m[4]);

        tmplLines[i] = `${m[1]}${m[2]}${m[3]}${formatTomlValue(values[k])}${commentSuffix}`;
    }

    const last = existing[existing.length - 1];
    let insertAt = last.endIndex + 1;

    while (insertAt - 1 > last.startIndex && lines[insertAt - 1].trim() === '') insertAt--;

    lines.splice(insertAt, 0, '', ...tmplLines);

    return lines.join('\n');
}

/** Remove the Nth `[[path]]` entry (0-based). */
export function removeCollectionItem(text: string, path: string[], index: number): string {
    const lines = text.split('\n');
    const blocks = indexBlocks(lines);
    const existing = findBlocks(blocks, path, true);

    if (index < 0 || index >= existing.length) {
        throw new Error(`removeCollectionItem: index ${index} out of range (0..${existing.length - 1})`);
    }

    const target = existing[index];
    const start = target.headerIndex!;
    let end = target.endIndex;

    if (end + 1 < lines.length && lines[end + 1].trim() === '') end++;

    lines.splice(start, end - start + 1);

    return lines.join('\n');
}

/**
 * Add a new map entry: `[parentPath.key]` with the given field values.
 * Uses the first existing sibling as a template if any.
 */
export function addMapItem(
    text: string,
    parentPath: string[],
    key: string,
    values: Record<string, unknown>,
): string {
    const lines = text.split('\n');
    const blocks = indexBlocks(lines);
    const fullPath = [...parentPath, key];
    const headerLine = `[${joinPath(fullPath)}]`;

    const siblings = blocks.filter(
        (b) => b.headerIndex !== null
            && !b.isArray
            && b.path.length === fullPath.length
            && b.path.slice(0, -1).every((s, i) => s === parentPath[i]),
    );

    if (siblings.length === 0) {
        const out = lines.slice();

        if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');

        out.push(headerLine);

        for (const [k, v] of Object.entries(values)) {
            out.push(`${k} = ${formatTomlValue(v)}`);
        }

        return out.join('\n');
    }

    const tmpl = siblings[0];
    const tmplStart = tmpl.headerIndex!;
    let tmplEnd = tmpl.endIndex;

    while (tmplEnd > tmpl.startIndex && lines[tmplEnd].trim() === '') tmplEnd--;

    const tmplLines = lines.slice(tmplStart, tmplEnd + 1);

    tmplLines[0] = headerLine;
    for (let i = 1; i < tmplLines.length; i++) {
        const m = KEY_RE.exec(tmplLines[i]);

        if (!m) continue;

        const k = m[2];

        if (!(k in values)) continue;

        const { commentSuffix } = splitValueAndComment(m[4]);

        tmplLines[i] = `${m[1]}${m[2]}${m[3]}${formatTomlValue(values[k])}${commentSuffix}`;
    }

    const last = siblings[siblings.length - 1];
    let insertAt = last.endIndex + 1;

    while (insertAt - 1 > last.startIndex && lines[insertAt - 1].trim() === '') insertAt--;

    lines.splice(insertAt, 0, '', ...tmplLines);

    return lines.join('\n');
}

/** Remove a map entry by full path (e.g. ['lsp', 'typescript']). */
export function removeMapItem(text: string, fullPath: string[]): string {
    const lines = text.split('\n');
    const blocks = indexBlocks(lines);
    const target = findAnyBlock(blocks, fullPath);

    if (target?.headerIndex == null) {
        throw new Error(`removeMapItem: ${fullPath.join('.')} not found`);
    }

    const start = target.headerIndex;
    let end = target.endIndex;

    if (end + 1 < lines.length && lines[end + 1].trim() === '') end++;

    lines.splice(start, end - start + 1);

    return lines.join('\n');
}

/** Validate that the produced text still parses as TOML. Throws on failure. */
export function validate(text: string): void {
    toml.parse(text);
}
