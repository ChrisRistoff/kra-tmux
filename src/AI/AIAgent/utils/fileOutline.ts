/**
 * File outline extraction.
 *
 * Primary path: ask the configured LSP server for `textDocument/documentSymbol`
 * — the server returns a precise, semantic list of definitions with start/end
 * lines, and the agent can grab a function with read_lines directly without a
 * follow-up read_function in many cases.
 *
 * Imports are not part of `documentSymbol`, so we collect them with a tiny
 * top-of-file regex scan per language.
 *
 * Falls back to a regex-based scan when no LSP server is configured for the
 * file's extension or when the LSP request fails. The regex path produces
 * start lines only; end is approximated as "next entry's start - 1".
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    DocumentSymbol,
    DocumentSymbolRequest,
    SymbolInformation,
    SymbolKind,
} from 'vscode-languageserver-protocol/node.js';
import { fileUri } from './lspClient';
import { getLspRegistry } from './lspRegistry';

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
    // True when the outline was produced by the LSP (endLine is exact).
    // False when it came from the regex fallback (endLine is approximated).
    accurate: boolean;
    // Top-of-file imports collected via a per-language regex scan.
    imports?: ImportInfo;
}

const PREVIEW_MAX_LEN = 80;

interface CacheEntry {
    mtime: number;
    outline: FileOutline;
}

const outlineCache = new Map<string, CacheEntry>();

// ────────────────────────────────────────────────────────────────────────────
// LSP path
// ────────────────────────────────────────────────────────────────────────────

// Subset of LSP SymbolKind values we surface in outlines, mapped to short labels
// matching what the previous tree-sitter implementation produced so existing
// consumers (and the agent's prompts) see no behavioural change.
const KIND_LABEL: Partial<Record<SymbolKind, string>> = {
    [SymbolKind.File]: 'file',
    [SymbolKind.Module]: 'module',
    [SymbolKind.Namespace]: 'namespace',
    [SymbolKind.Package]: 'package',
    [SymbolKind.Class]: 'class',
    [SymbolKind.Method]: 'method',
    [SymbolKind.Property]: 'property',
    [SymbolKind.Field]: 'field',
    [SymbolKind.Constructor]: 'constructor',
    [SymbolKind.Enum]: 'enum',
    [SymbolKind.Interface]: 'interface',
    [SymbolKind.Function]: 'function',
    [SymbolKind.Variable]: 'const',
    [SymbolKind.Constant]: 'const',
    [SymbolKind.EnumMember]: 'enum-member',
    [SymbolKind.Struct]: 'struct',
    [SymbolKind.TypeParameter]: 'type',
};

// SymbolKinds we suppress from the outline (would just be noise: string
// literals, numeric literals, individual array/object expressions, etc.).
const SKIP_KINDS = new Set<SymbolKind>([
    SymbolKind.String,
    SymbolKind.Number,
    SymbolKind.Boolean,
    SymbolKind.Array,
    SymbolKind.Object,
    SymbolKind.Key,
    SymbolKind.Null,
    SymbolKind.Event,
    SymbolKind.Operator,
]);

function makePreview(line: string | undefined): string {
    if (!line) return '';
    const trimmed = line.trim();

    return trimmed.length > PREVIEW_MAX_LEN
        ? trimmed.slice(0, PREVIEW_MAX_LEN - 1) + '…'
        : trimmed;
}

function kindLabel(kind: SymbolKind): string | undefined {
    if (SKIP_KINDS.has(kind)) return undefined;

    return KIND_LABEL[kind];
}

function isDocumentSymbolArray(value: unknown): value is DocumentSymbol[] {
    return Array.isArray(value)
        && (value.length === 0
            || (value[0] !== null
                && typeof value[0] === 'object'
                && 'range' in (value[0] as object)
                && 'selectionRange' in (value[0] as object)));
}

function flattenDocumentSymbols(
    symbols: DocumentSymbol[],
    lines: string[],
    out: OutlineEntry[],
    insideClass: boolean,
): void {
    for (const sym of symbols) {
        // documentSymbol uses 0-indexed lines; our outline is 1-indexed.
        const start = sym.range.start.line + 1;
        const end = sym.range.end.line + 1;

        let label = kindLabel(sym.kind);
        if (label) {
            // Reclassify Function-kind symbols nested directly in a class as methods,
            // matching the previous tree-sitter behaviour. Some servers report class
            // members with SymbolKind.Function instead of Method.
            if (insideClass && sym.kind === SymbolKind.Function) label = 'method';

            out.push({
                name: sym.name,
                kind: label,
                line: start,
                endLine: end,
                preview: makePreview(lines[start - 1]),
            });
        }

        if (sym.children && sym.children.length > 0) {
            const childInsideClass = insideClass
                || sym.kind === SymbolKind.Class
                || sym.kind === SymbolKind.Interface
                || sym.kind === SymbolKind.Struct;
            flattenDocumentSymbols(sym.children, lines, out, childInsideClass);
        }
    }
}

function flattenSymbolInformation(
    symbols: SymbolInformation[],
    lines: string[],
): OutlineEntry[] {
    const out: OutlineEntry[] = [];
    for (const sym of symbols) {
        const label = kindLabel(sym.kind);
        if (!label) continue;
        const start = sym.location.range.start.line + 1;
        const end = sym.location.range.end.line + 1;
        out.push({
            name: sym.name,
            kind: label,
            line: start,
            endLine: end,
            preview: makePreview(lines[start - 1]),
        });
    }

    return out;
}

async function tryLsp(filePath: string, lines: string[]): Promise<OutlineEntry[] | undefined> {
    const absPath = path.resolve(filePath);
    let registry;
    try {
        registry = await getLspRegistry();
    } catch {
        return undefined;
    }
    if (!registry.hasServerFor(absPath)) return undefined;

    let client;
    try {
        client = await registry.getClientFor(absPath);
    } catch {
        return undefined;
    }
    if (!client) return undefined;

    try {
        await client.openFile(absPath);
        const result = await client.sendRequest<unknown, DocumentSymbol[] | SymbolInformation[] | null>(
            DocumentSymbolRequest.type,
            { textDocument: { uri: fileUri(absPath) } },
        );
        if (!result) return [];

        const entries: OutlineEntry[] = [];
        if (isDocumentSymbolArray(result)) {
            flattenDocumentSymbols(result, lines, entries, false);
        } else {
            entries.push(...flattenSymbolInformation(result, lines));
        }

        // Dedup on (name, line) — some servers emit overlapping entries.
        const seen = new Set<string>();
        const dedup = entries.filter((e) => {
            const k = `${e.name}@${e.line}`;
            if (seen.has(k)) return false;
            seen.add(k);

            return true;
        });
        dedup.sort((a, b) => a.line - b.line);

        return dedup;
    } catch {
        return undefined;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Import extraction (regex; LSP documentSymbol does not include imports)
// ────────────────────────────────────────────────────────────────────────────

type ImportLang = 'js' | 'py' | 'go';

function importLang(filePath: string): ImportLang | undefined {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.ts': case '.tsx': case '.mts': case '.cts':
        case '.js': case '.jsx': case '.mjs': case '.cjs':
            return 'js';
        case '.py': case '.pyi':
            return 'py';
        case '.go':
            return 'go';
        default:
            return undefined;
    }
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

function extractImports(filePath: string, lines: string[]): ImportInfo | undefined {
    const lang = importLang(filePath);
    if (!lang) return undefined;

    switch (lang) {
        case 'js': return extractImportsJs(lines);
        case 'py': return extractImportsPy(lines);
        case 'go': return extractImportsGo(lines);
    }
}

const JS_IMPORT_RE = /^\s*(?:import|export)\b[^;]*?from\s+(['"`])([^'"`]+)\1/;
const JS_BARE_IMPORT_RE = /^\s*import\s+(['"`])([^'"`]+)\1/;

function extractImportsJs(lines: string[]): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

        // Multi-line import: collect lines until we see the matching `from '…'` or bare `'…'`.
        if (/^\s*import\b/.test(raw) || /^\s*export\b.*\bfrom\b/.test(raw)) {
            const startLine = i + 1;
            let buf = raw;
            while (i < lines.length - 1 && !/['"`]\s*;?\s*$/.test(lines[i]) && !/from\s+['"`][^'"`]+['"`]/.test(buf)) {
                i++;
                buf += ' ' + lines[i];
            }
            const m = JS_IMPORT_RE.exec(buf) ?? JS_BARE_IMPORT_RE.exec(buf);
            if (m) {
                sources.push(m[2]);
                firstLine = Math.min(firstLine, startLine);
                lastLine = Math.max(lastLine, i + 1);
            }
            continue;
        }

        // Stop scanning once we hit a non-import top-level construct.
        break;
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
}

function extractImportsPy(lines: string[]): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;
    let inFromBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (/^\s*(import|from)\b/.test(raw)) {
            const startLine = i + 1;
            let buf = trimmed;
            // Handle parenthesised multi-line `from x import (a, b, c)`.
            if (buf.includes('(') && !buf.includes(')')) {
                inFromBlock = true;
                while (i < lines.length - 1 && inFromBlock) {
                    i++;
                    buf += ' ' + lines[i].trim();
                    if (buf.includes(')')) inFromBlock = false;
                }
            }
            const label = buf.replace(/\s+/g, ' ').trim();
            sources.push(label.length > 60 ? label.slice(0, 59) + '…' : label);
            firstLine = Math.min(firstLine, startLine);
            lastLine = Math.max(lastLine, i + 1);
            continue;
        }

        // Stop scanning at the first non-import construct (Python convention).
        break;
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
}

const GO_IMPORT_SINGLE_RE = /^\s*import\s+(?:[A-Za-z_.][\w.]*\s+)?(['"`][^'"`]+['"`])/;
const GO_IMPORT_SPEC_RE = /^\s*(?:[A-Za-z_.][\w.]*\s+)?(['"`][^'"`]+['"`])/;

function extractImportsGo(lines: string[]): ImportInfo | undefined {
    const sources: string[] = [];
    let firstLine = Infinity;
    let lastLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('package')) continue;

        if (/^\s*import\s*\(/.test(raw)) {
            const startLine = i + 1;
            i++;
            while (i < lines.length && !/^\s*\)/.test(lines[i])) {
                const m = GO_IMPORT_SPEC_RE.exec(lines[i]);
                if (m) sources.push(unquote(m[1]));
                i++;
            }
            firstLine = Math.min(firstLine, startLine);
            lastLine = Math.max(lastLine, i + 1);
            continue;
        }

        const single = GO_IMPORT_SINGLE_RE.exec(raw);
        if (single) {
            sources.push(unquote(single[1]));
            firstLine = Math.min(firstLine, i + 1);
            lastLine = Math.max(lastLine, i + 1);
            continue;
        }

        // Stop once we leave the import section.
        if (/^\s*(func|type|var|const)\b/.test(raw)) break;
    }

    if (sources.length === 0) return undefined;

    return { firstLine, lastLine, sources };
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

function regexOutline(lines: string[]): OutlineEntry[] {
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

    return entries;
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

    const lspEntries = await tryLsp(filePath, lines);
    const imports = extractImports(filePath, lines);

    let outline: FileOutline;
    if (lspEntries) {
        outline = { lineCount: lines.length, entries: lspEntries, accurate: true };
    } else {
        outline = { lineCount: lines.length, entries: regexOutline(lines), accurate: false };
    }
    if (imports) outline.imports = imports;

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
