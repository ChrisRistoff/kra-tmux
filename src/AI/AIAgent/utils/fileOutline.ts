/**
 * File outline extraction.
 *
 * Uses tree-sitter (proper AST parsing) for TypeScript, JavaScript, Python and
 * Go — these give us accurate start AND end lines per symbol so the agent can
 * grab a function with read_lines directly without a follow-up read_function.
 *
 * Falls back to a regex-based scan for unknown extensions or if a tree-sitter
 * grammar fails to load (e.g. missing native binding). The regex path produces
 * start lines only; end is approximated as "next entry's start - 1".
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface OutlineEntry {
    name: string;
    kind: string;
    line: number;
    endLine: number;
    // Trimmed preview of the definition line (~80 chars). Lets the AI identify
    // the right symbol without a follow-up read_function in many cases.
    preview: string;
}

export interface ImportInfo {
    // First and last source-line covered by the contiguous import block.
    firstLine: number;
    lastLine: number;
    // Module specifiers in source order (quotes stripped).
    sources: string[];
}

export interface FileOutline {
    lineCount: number;
    entries: OutlineEntry[];
    // True when the outline was produced by tree-sitter (endLine is exact).
    // False when it came from the regex fallback (endLine is approximated).
    accurate: boolean;
    // Top-of-file imports collected via tree-sitter (when the grammar is supported).
    imports?: ImportInfo;
}

const PREVIEW_MAX_LEN = 80;

interface CacheEntry {
    mtime: number;
    outline: FileOutline;
}

const outlineCache = new Map<string, CacheEntry>();

// ────────────────────────────────────────────────────────────────────────────
// Tree-sitter path
// ────────────────────────────────────────────────────────────────────────────

interface ITsNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: ITsNode[];
    childForFieldName: (name: string) => ITsNode | null;
}

interface ITsParser {
    parse: (input: string) => { rootNode: ITsNode };
    setLanguage: (lang: unknown) => void;
}

interface ILanguageSpec {
    parser: ITsParser;
    visit: (root: ITsNode, out: OutlineEntry[], lines: string[]) => void;
    extractImports?: (root: ITsNode) => ImportInfo | undefined;
}

const langCache = new Map<string, ILanguageSpec | null>();

function loadLanguage(key: string): ILanguageSpec | null {
    if (langCache.has(key)) return langCache.get(key) ?? null;

    let spec: ILanguageSpec | null = null;
    try {
        const parserCtor = require('tree-sitter') as new () => ITsParser;
        const parser = new parserCtor();

        switch (key) {
            case 'ts': {
                const tsMod = require('tree-sitter-typescript') as { typescript: unknown };
                parser.setLanguage(tsMod.typescript);
                spec = { parser, visit: visitJsLike, extractImports: extractImportsJsLike };
                break;
            }
            case 'tsx': {
                const tsMod = require('tree-sitter-typescript') as { tsx: unknown };
                parser.setLanguage(tsMod.tsx);
                spec = { parser, visit: visitJsLike, extractImports: extractImportsJsLike };
                break;
            }
            case 'js': {
                parser.setLanguage(require('tree-sitter-javascript'));
                spec = { parser, visit: visitJsLike, extractImports: extractImportsJsLike };
                break;
            }
            case 'py': {
                parser.setLanguage(require('tree-sitter-python'));
                spec = { parser, visit: visitPython, extractImports: extractImportsPython };
                break;
            }
            case 'go': {
                parser.setLanguage(require('tree-sitter-go'));
                spec = { parser, visit: visitGo, extractImports: extractImportsGo };
                break;
            }
        }
    } catch {
        spec = null;
    }

    langCache.set(key, spec);

    return spec;
}

function extKey(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.ts': case '.mts': case '.cts': return 'ts';
        case '.tsx': return 'tsx';
        case '.js': case '.jsx': case '.mjs': case '.cjs': return 'js';
        case '.py': return 'py';
        case '.go': return 'go';
        default: return undefined;
    }
}

function makePreview(line: string | undefined): string {
    if (!line) return '';
    const trimmed = line.trim();

    return trimmed.length > PREVIEW_MAX_LEN
        ? trimmed.slice(0, PREVIEW_MAX_LEN - 1) + '…'
        : trimmed;
}

function pushEntry(out: OutlineEntry[], lines: string[], node: ITsNode, name: string, kind: string): void {
    const start = node.startPosition.row + 1;
    const end = node.endPosition.row + 1;
    out.push({ name, kind, line: start, endLine: end, preview: makePreview(lines[start - 1]) });
}

function getName(node: ITsNode): string | undefined {
    return node.childForFieldName('name')?.text ?? undefined;
}

function unquote(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
            return s.slice(1, -1);
        }
    }

    return s;
}

// Walk only top-level children — imports are conventionally at the top of the file.
function extractImportsJsLike(root: ITsNode): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;

    for (const node of root.children) {
        let src: ITsNode | null = null;
        if (node.type === 'import_statement' || node.type === 'export_statement') {
            src = node.childForFieldName('source');
        }
        if (!src) continue;
        sources.push(unquote(src.text));
        firstLine = Math.min(firstLine, node.startPosition.row + 1);
        lastLine = Math.max(lastLine, node.endPosition.row + 1);
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
}

function extractImportsPython(root: ITsNode): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;

    for (const node of root.children) {
        if (node.type !== 'import_statement' && node.type !== 'import_from_statement') continue;
        const label = node.text.replace(/\s+/g, ' ').trim();
        sources.push(label.length > 60 ? label.slice(0, 59) + '…' : label);
        firstLine = Math.min(firstLine, node.startPosition.row + 1);
        lastLine = Math.max(lastLine, node.endPosition.row + 1);
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
}

function extractImportsGo(root: ITsNode): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;

    const collectSpec = (n: ITsNode): void => {
        if (n.type === 'import_spec') {
            const path = n.childForFieldName('path')
                ?? n.children.find((c) => c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal')
                ?? null;
            if (path) sources.push(unquote(path.text));

            return;
        }
        for (const c of n.children) collectSpec(c);
    };

    for (const node of root.children) {
        if (node.type !== 'import_declaration') continue;
        firstLine = Math.min(firstLine, node.startPosition.row + 1);
        lastLine = Math.max(lastLine, node.endPosition.row + 1);
        collectSpec(node);
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
}

// JavaScript / TypeScript / TSX share the same grammar shape for the kinds we care about.
function visitJsLike(root: ITsNode, out: OutlineEntry[], lines: string[]): void {
    const visit = (node: ITsNode, insideClass: boolean): void => {
        switch (node.type) {
            case 'function_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, lines, node, n, 'function');
                break;
            }
            case 'class_declaration':
            case 'abstract_class_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, lines, node, n, 'class');
                for (const c of node.children) visit(c, true);

                return;
            }
            case 'interface_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, lines, node, n, 'interface');
                break;
            }
            case 'type_alias_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, lines, node, n, 'type');
                break;
            }
            case 'enum_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, lines, node, n, 'enum');
                break;
            }
            case 'method_definition':
            case 'method_signature':
            case 'abstract_method_signature': {
                if (insideClass) {
                    const n = getName(node);
                    if (n) pushEntry(out, lines, node, n, 'method');
                }
                break;
            }
            case 'public_field_definition':
            case 'property_signature': {
                if (insideClass) {
                    const n = getName(node);
                    if (n) pushEntry(out, lines, node, n, 'field');
                }
                break;
            }
            case 'lexical_declaration':
            case 'variable_declaration': {
                // Hoist arrow / function-expression consts to the outline.
                for (const decl of node.children) {
                    if (decl.type !== 'variable_declarator') continue;
                    const init = decl.childForFieldName('value');
                    if (!init || (init.type !== 'arrow_function' && init.type !== 'function_expression' && init.type !== 'function')) continue;
                    const nameNode = decl.childForFieldName('name');
                    const n = nameNode?.text;
                    if (n) pushEntry(out, lines, decl, n, 'const');
                }
                break;
            }
        }
        for (const c of node.children) visit(c, insideClass);
    };
    visit(root, false);
}

function visitPython(root: ITsNode, out: OutlineEntry[], lines: string[]): void {
    const visit = (node: ITsNode, insideClass: boolean): void => {
        if (node.type === 'function_definition') {
            const n = getName(node);
            if (n) pushEntry(out, lines, node, n, insideClass ? 'method' : 'function');
        } else if (node.type === 'class_definition') {
            const n = getName(node);
            if (n) pushEntry(out, lines, node, n, 'class');
            for (const c of node.children) visit(c, true);

            return;
        }
        for (const c of node.children) visit(c, insideClass);
    };
    visit(root, false);
}

function visitGo(root: ITsNode, out: OutlineEntry[], _lines: string[]): void {
    for (const node of root.children) {
        switch (node.type) {
            case 'function_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, _lines, node, n, 'func');
                break;
            }
            case 'method_declaration': {
                const n = getName(node);
                if (n) pushEntry(out, _lines, node, n, 'method');
                break;
            }
            case 'type_declaration': {
                for (const spec of node.children) {
                    if (spec.type !== 'type_spec') continue;
                    const nameNode = spec.childForFieldName('name');
                    const n = nameNode?.text;
                    if (n) pushEntry(out, _lines, spec, n, 'type');
                }
                break;
            }
        }
    }
}

function tryTreeSitter(filePath: string, content: string, lines: string[]): FileOutline | undefined {
    const key = extKey(filePath);
    if (!key) return undefined;
    const lang = loadLanguage(key);
    if (!lang) return undefined;

    try {
        const tree = lang.parser.parse(content);
        const entries: OutlineEntry[] = [];
        lang.visit(tree.rootNode, entries, lines);
        // Tree-sitter walks may produce duplicates for some nested cases; keep first occurrence per (name,line).
        const seen = new Set<string>();
        const dedup = entries.filter((e) => {
            const k = `${e.name}@${e.line}`;
            if (seen.has(k)) return false;
            seen.add(k);

            return true;
        });
        // Sort by line for stable output.
        dedup.sort((a, b) => a.line - b.line);

        const imports = lang.extractImports ? lang.extractImports(tree.rootNode) : undefined;

        const result: FileOutline = { lineCount: lines.length, entries: dedup, accurate: true };
        if (imports) result.imports = imports;

        return result;
    } catch {
        return undefined;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Regex fallback
// ────────────────────────────────────────────────────────────────────────────

const PATTERNS: { kind: string; re: RegExp }[] = [
    { kind: 'method', re: /^    def\s+(\w+)/ },
    { kind: 'method', re: /^(?:\s{2,}|\t+)(?:(?:public|private|protected|static|override|abstract|async|readonly)\s+)*(?:async\s+)?(?:get |set )?(\w+)\s*(?:\(|<)/ },
    { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/ },
    { kind: 'const', re: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w_$]+)\s*=>/ },
    { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    { kind: 'interface', re: /^(?:export\s+)?interface\s+(\w+)/ },
    { kind: 'type', re: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/ },
    { kind: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/ },
    { kind: 'def', re: /^def\s+(\w+)/ },
    { kind: 'class', re: /^class\s+(\w+)/ },
    { kind: 'func', re: /^func\s+(?:\([^)]+\)\s+)?(\w+)/ },
    { kind: 'type', re: /^type\s+(\w+)\s+(?:struct|interface)/ },
];

function regexOutline(lines: string[]): FileOutline {
    const entries: OutlineEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
        }

        for (const { kind, re } of PATTERNS) {
            const match = re.exec(line);
            if (match?.[1]) {
                entries.push({
                    name: match[1],
                    kind,
                    line: i + 1,
                    endLine: i + 1,
                    preview: makePreview(line),
                });
                break;
            }
        }
    }

    // Approximate end lines: next entry's start - 1, or lineCount for the last.
    for (let i = 0; i < entries.length; i++) {
        if (i + 1 < entries.length) {
            entries[i].endLine = Math.max(entries[i + 1].line - 1, entries[i].line);
        } else {
            entries[i].endLine = lines.length;
        }
    }

    return { lineCount: lines.length, entries, accurate: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export async function getFileOutline(filePath: string): Promise<FileOutline> {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = outlineCache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.outline;

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');

    const outline = tryTreeSitter(filePath, content, lines) ?? regexOutline(lines);
    outlineCache.set(filePath, { mtime, outline });

    return outline;
}

export function formatOutline(filePath: string, outline: FileOutline): string {
    const tag = outline.accurate ? '' : ' (approximate)';
    const header = `File: ${filePath} (${outline.lineCount} lines)${tag}`;

    const importsRow = outline.imports ? formatImportsRow(outline.imports) : undefined;

    if (outline.entries.length === 0 && !importsRow) {
        return `${header}\nNo recognizable definitions found. Use read_lines to read sections directly.`;
    }

    const rows = outline.entries.map((e) => {
        const range = e.line === e.endLine ? `L${e.line}` : `L${e.line}-${e.endLine}`;

        return `  ${range.padEnd(13)} ${e.kind.padEnd(11)} ${e.name.padEnd(28)} ${e.preview}`;
    });

    const allRows = importsRow ? [importsRow, ...rows] : rows;

    return [header, '', ...allRows].join('\n');
}

function formatImportsRow(imp: ImportInfo): string {
    const range = imp.firstLine === imp.lastLine ? `L${imp.firstLine}` : `L${imp.firstLine}-${imp.lastLine}`;
    const count = `(${imp.sources.length})`;
    const joined = imp.sources.join(', ');
    const PREVIEW_CAP = 120;
    const preview = joined.length > PREVIEW_CAP ? joined.slice(0, PREVIEW_CAP - 1) + '…' : joined;

    return `  ${range.padEnd(13)} ${'imports'.padEnd(11)} ${count.padEnd(28)} ${preview}`;
}

export function findFunctionRange(
    outline: FileOutline,
    name: string
): { start: number; end: number } | undefined {
    const entry = outline.entries.find((e) => e.name === name);
    if (!entry) return undefined;

    return { start: entry.line, end: entry.endLine };
}
