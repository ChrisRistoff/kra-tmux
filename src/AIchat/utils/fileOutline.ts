import * as fs from 'fs/promises';

export interface OutlineEntry {
    name: string;
    kind: string;
    line: number;
}

export interface FileOutline {
    lineCount: number;
    entries: OutlineEntry[];
}

// Ordered from most specific to least — first match wins per line.
const PATTERNS: { kind: string; re: RegExp }[] = [
    // Python / indented methods before top-level so they don't match top-level patterns
    { kind: 'method', re: /^    def\s+(\w+)/ },
    // TS/JS methods (2+ spaces or tab-indented, various modifiers)
    { kind: 'method', re: /^(?:\s{2,}|\t+)(?:(?:public|private|protected|static|override|abstract|async|readonly)\s+)*(?:async\s+)?(?:get |set )?(\w+)\s*(?:\(|<)/ },
    // Top-level functions
    { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/ },
    // Top-level arrow functions assigned to const
    { kind: 'const', re: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w_$]+)\s*=>/ },
    // Classes
    { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    // Interfaces
    { kind: 'interface', re: /^(?:export\s+)?interface\s+(\w+)/ },
    // Type aliases
    { kind: 'type', re: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/ },
    // Enums
    { kind: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/ },
    // Python top-level def/class
    { kind: 'def', re: /^def\s+(\w+)/ },
    { kind: 'class', re: /^class\s+(\w+)/ },
    // Go
    { kind: 'func', re: /^func\s+(?:\([^)]+\)\s+)?(\w+)/ },
    { kind: 'type', re: /^type\s+(\w+)\s+(?:struct|interface)/ },
];

interface CacheEntry {
    mtime: number;
    outline: FileOutline;
}

const outlineCache = new Map<string, CacheEntry>();

export async function getFileOutline(filePath: string): Promise<FileOutline> {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = outlineCache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.outline;

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const entries: OutlineEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        // Skip blank lines and pure comment lines.
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
        }

        for (const { kind, re } of PATTERNS) {
            const match = re.exec(line);
            if (match?.[1]) {
                entries.push({ name: match[1], kind, line: i + 1 });
                break;
            }
        }
    }

    const outline: FileOutline = { lineCount: lines.length, entries };
    outlineCache.set(filePath, { mtime, outline });
    return outline;
}

export function formatOutline(filePath: string, outline: FileOutline): string {
    const header = `File: ${filePath} (${outline.lineCount} lines)`;

    if (outline.entries.length === 0) {
        return `${header}\nNo recognizable definitions found. Use read_lines to read sections directly.`;
    }

    const rows = outline.entries.map(
        (e) => `  L${String(e.line).padEnd(5)} ${e.kind.padEnd(11)} ${e.name}`
    );

    return [header, '', ...rows].join('\n');
}

export function findFunctionRange(
    outline: FileOutline,
    name: string
): { start: number; end: number } | undefined {
    const idx = outline.entries.findIndex((e) => e.name === name);

    if (idx === -1) return undefined;

    const start = outline.entries[idx].line;
    // End is the line before the next top-level entry (or EOF).
    const next = outline.entries.slice(idx + 1).find((e) => e.line > start);
    const end = next ? next.line - 1 : outline.lineCount;

    return { start, end };
}
