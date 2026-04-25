/**
 * Handler for the `lsp_query` MCP tool.
 *
 * Dispatches one of a small set of LSP requests (hover, definition,
 * references, implementation, type_definition, document_symbols) at a target
 * position in a file. The position can be given directly as (line, col) or
 * resolved by scanning a line for an occurrence of `symbol`.
 *
 * Results are formatted as plain text — short locations, hover markdown, or
 * a flattened symbol tree — so the agent can read them directly without an
 * extra parsing step.
 */

import * as path from 'path';
import { getLspRegistry } from './lspRegistry';
import { fileUri, uriToPath } from './lspClient';
import {
    HoverRequest,
    DefinitionRequest,
    ReferencesRequest,
    ImplementationRequest,
    TypeDefinitionRequest,
    DocumentSymbolRequest,
    Hover,
    Location,
    LocationLink,
    DocumentSymbol,
    SymbolInformation,
    SymbolKind,
    MarkupContent,
    Range,
    Position,
} from 'vscode-languageserver-protocol/node.js';

export type LspOp =
    | 'hover'
    | 'definition'
    | 'references'
    | 'implementation'
    | 'type_definition'
    | 'document_symbols';

const OPS: ReadonlySet<LspOp> = new Set([
    'hover', 'definition', 'references', 'implementation', 'type_definition', 'document_symbols',
]);

export type LspQueryArgs = {
    file_path: string;
    op: LspOp;
    line?: number;
    col?: number;
    symbol?: string;
    occurrence?: number;
    include_declaration?: boolean;
}

export function isValidOp(op: unknown): op is LspOp {
    return typeof op === 'string' && OPS.has(op as LspOp);
}

const KIND_NAME: Record<number, string> = Object.fromEntries(
    Object.entries(SymbolKind).map(([name, num]) => [num as number, name]),
);

function symbolKindName(kind: SymbolKind): string {
    return KIND_NAME[kind] ?? `Kind(${kind})`;
}


function fmtRange(r: Range): string {
    return `${r.start.line + 1}:${r.start.character + 1}`;
}

function fmtLocation(loc: Location): string {
    return `${uriToPath(loc.uri)}:${fmtRange(loc.range)}`;
}

function fmtLocationLink(link: LocationLink): string {
    return `${uriToPath(link.targetUri)}:${fmtRange(link.targetSelectionRange ?? link.targetRange)}`;
}

function fmtLocations(result: Location | Location[] | LocationLink[] | null): string {
    if (!result) return '(no results)';
    const list = Array.isArray(result) ? result : [result];
    if (list.length === 0) return '(no results)';

    return list.map(item => {
        if ('targetUri' in item) return fmtLocationLink(item);

        return fmtLocation(item);
    }).join('\n');
}

function fmtHoverContents(content: Hover['contents']): string {
    if (Array.isArray(content)) {
        return content.map(c => typeof c === 'string' ? c : c.value).join('\n\n');
    }
    if (typeof content === 'string') return content;
    if ((content as MarkupContent).kind !== undefined) return (content as MarkupContent).value;

    return (content as { value: string }).value;
}

function flattenDocumentSymbols(symbols: DocumentSymbol[], depth = 0, out: string[] = []): string[] {
    for (const s of symbols) {
        const indent = '  '.repeat(depth);
        out.push(`${indent}${symbolKindName(s.kind)} ${s.name}  ${fmtRange(s.range)}`);
        if (s.children && s.children.length > 0) {
            flattenDocumentSymbols(s.children, depth + 1, out);
        }
    }

    return out;
}

function fmtSymbolInformation(items: SymbolInformation[]): string {
    return items.map(s => `${symbolKindName(s.kind)} ${s.name}  ${fmtLocation(s.location)}`).join('\n');
}

function isDocumentSymbolArray(value: unknown): value is DocumentSymbol[] {
    return Array.isArray(value) && (value.length === 0 || (value[0] !== null && typeof value[0] === 'object' && 'range' in (value[0] as object)));
}

function resolvePosition(args: LspQueryArgs, openText: string | undefined): Position | { error: string } {
    const lineNum = typeof args.line === 'number' ? args.line : undefined;
    if (lineNum === undefined || lineNum < 1) {
        return { error: 'line is required (1-indexed) for this op' };
    }
    const lineIndex = lineNum - 1;

    if (typeof args.col === 'number' && args.col >= 1) {
        return { line: lineIndex, character: args.col - 1 };
    }

    if (typeof args.symbol === 'string' && args.symbol.length > 0) {
        if (!openText) return { error: 'cannot resolve symbol: file content unavailable' };
        const lines = openText.split('\n');
        if (lineIndex >= lines.length) return { error: `line ${lineNum} is past end of file (${lines.length} lines)` };
        const text = lines[lineIndex] ?? '';
        const occurrence = Math.max(1, args.occurrence ?? 1);
        let from = 0;
        let found = -1;
        for (let i = 0; i < occurrence; i++) {
            found = text.indexOf(args.symbol, from);
            if (found < 0) return { error: `symbol "${args.symbol}" not found on line ${lineNum} (occurrence ${occurrence})` };
            from = found + args.symbol.length;
        }

        return { line: lineIndex, character: found };
    }

    return { error: 'must supply col or symbol' };
}

/**
 * Run an LSP op and return a plain-text payload suitable for the MCP
 * `text` content block.
 */
export async function runLspQuery(args: LspQueryArgs): Promise<string> {
    if (!args.file_path || typeof args.file_path !== 'string') {
        return 'Error: file_path is required.';
    }
    if (!isValidOp(args.op)) {
        return `Error: op must be one of: ${Array.from(OPS).join(', ')}`;
    }

    const absPath = path.resolve(args.file_path);
    const registry = await getLspRegistry();
    if (!registry.hasServerFor(absPath)) {
        const exts = registry.listConfiguredExtensions();
        const ext = path.extname(absPath).toLowerCase();
        const hint = exts.length > 0
            ? `Configured: ${exts.join(', ')}.`
            : 'No LSP servers configured under [lsp.*] in settings.toml.';

        return `No LSP server is configured for ${ext || '(no extension)'}. ${hint}`;
    }

    let client;
    try {
        client = await registry.getClientFor(absPath);
    } catch (err) {
        return `Failed to start LSP server: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!client) return 'No LSP server matched this file.';

    try {
        await client.openFile(absPath);
    } catch (err) {
        return `Failed to open ${absPath} in LSP: ${err instanceof Error ? err.message : String(err)}`;
    }
    const uri = fileUri(absPath);

    if (args.op === 'document_symbols') {
        try {
            const result = await client.sendRequest<unknown, DocumentSymbol[] | SymbolInformation[] | null>(
                DocumentSymbolRequest.type, { textDocument: { uri } },
            );
            if (!result || (Array.isArray(result) && result.length === 0)) return '(no symbols)';
            if (isDocumentSymbolArray(result)) return flattenDocumentSymbols(result).join('\n');

            return fmtSymbolInformation(result);
        } catch (err) {
            return `LSP document_symbols failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    const pos = resolvePosition(args, client.getOpenText(absPath));
    if ('error' in pos) return `Error: ${pos.error}`;

    try {
        switch (args.op) {
            case 'hover': {
                const result = await client.sendRequest<unknown, Hover | null>(
                    HoverRequest.type, { textDocument: { uri }, position: pos },
                );
                if (!result?.contents) return '(no hover info)';

                return fmtHoverContents(result.contents);
            }
            case 'definition': {
                const result = await client.sendRequest<unknown, Location | Location[] | LocationLink[] | null>(
                    DefinitionRequest.type, { textDocument: { uri }, position: pos },
                );

                return fmtLocations(result);
            }
            case 'references': {
                const result = await client.sendRequest<unknown, Location[] | null>(
                    ReferencesRequest.type,
                    {
                        textDocument: { uri },
                        position: pos,
                        context: { includeDeclaration: args.include_declaration ?? true },
                    },
                );

                return fmtLocations(result);
            }
            case 'implementation': {
                const result = await client.sendRequest<unknown, Location | Location[] | LocationLink[] | null>(
                    ImplementationRequest.type, { textDocument: { uri }, position: pos },
                );

                return fmtLocations(result);
            }
            case 'type_definition': {
                const result = await client.sendRequest<unknown, Location | Location[] | LocationLink[] | null>(
                    TypeDefinitionRequest.type, { textDocument: { uri }, position: pos },
                );

                return fmtLocations(result);
            }
        }
    } catch (err) {
        return `LSP ${args.op} failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    return '(unhandled op)';
}
