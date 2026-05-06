/**
 * Single entry point for post-edit diagnostics. Resolves to the cheapest
 * source that can answer for the given file:
 *
 *   1. If the file's configured LSP server advertises
 *      `diagnosticProvider.workspaceDiagnostics`, ask it for project-wide
 *      pull diagnostics via `workspace/diagnostic` (LSP 3.17). This is the
 *      preferred path for languages like Go (gopls) and Rust (rust-analyzer)
 *      when their `[lsp.*]` blocks are active.
 *   2. Else if the file is TypeScript/JavaScript, run a project-wide check
 *      against the in-process TypeScript Compiler API (no TS LSP server in
 *      the wild advertises workspaceDiagnostics today: typescript-language-
 *      server, vtsls and biome are all push-only).
 *   3. Else if the file has a configured LSP server, ask it for single-file
 *      diagnostics via `textDocument/diagnostic` (pull) or cached
 *      `publishDiagnostics` (push).
 *   4. Else return undefined.
 *
 * On unexpected error in (1) or (2) we fall through to (3) / single-file TS
 * fallback so the agent never loses diagnostics due to a transient failure.
 */

import * as path from 'path';
import { getLspRegistry } from './lspRegistry';
import { fileUri, LspClient } from './lspClient';
import {
    DocumentDiagnosticRequest,
    WorkspaceDiagnosticRequest,
    Diagnostic,
    DiagnosticSeverity,
} from 'vscode-languageserver-protocol/node.js';
import {
    getDiagnosticsForFile,
    getDiagnosticsForProject,
    isTsLikeFile,
} from './lspDiagnostics';

const DEFAULT_PUSH_WAIT_MS = 800;
const MAX_DIAGNOSTICS = 20;
const MAX_WORKSPACE_DIAGNOSTICS = 30;

function severityLabel(sev: DiagnosticSeverity | undefined): string {
    switch (sev) {
        case DiagnosticSeverity.Error: return 'error';
        case DiagnosticSeverity.Warning: return 'warning';
        case DiagnosticSeverity.Information: return 'info';
        case DiagnosticSeverity.Hint: return 'hint';
        default: return 'diagnostic';
    }
}

function formatOne(d: Diagnostic): string {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const sev = severityLabel(d.severity);
    const code = d.code !== undefined ? ` ${String(d.code)}` : '';
    const msg = d.message.replace(/\n+/g, '\n  ');

    return `  L${line}:${col}  ${sev}${code}: ${msg}`;
}

function isErrorOrWarning(d: Diagnostic): boolean {
    if (d.severity === undefined) return true; // be conservative

    return d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning;
}

/**
 * Single-file diagnostics from a configured LSP server. Used as the
 * fallback path inside `getProjectDiagnostics`. Public so tests / future
 * callers can hit it directly, but new code should prefer
 * `getProjectDiagnostics`.
 */
export async function getLspDiagnosticsForFile(filePath: string, waitMs = DEFAULT_PUSH_WAIT_MS): Promise<string | undefined> {
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
        // Re-sync content first; the file may have just been edited.
        await client.refreshFile(absPath);
        await client.openFile(absPath);
    } catch {
        return undefined;
    }

    const uri = fileUri(absPath);
    const supportsPull = client.capabilities?.diagnosticProvider !== undefined;

    let diags: Diagnostic[] | undefined;

    if (supportsPull) {
        try {
            const report = await client.sendRequest<unknown, { kind?: string; items?: Diagnostic[] } | null>(
                DocumentDiagnosticRequest.type, { textDocument: { uri } },
            );
            diags = report?.items;
        } catch {
            // Fall through to push mode.
        }
    }

    if (!diags) {
        diags = client.getCachedDiagnostics(absPath);
        if (!diags && waitMs > 0) {
            const deadline = Date.now() + waitMs;
            const step = 50;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, step));
                diags = client.getCachedDiagnostics(absPath);
                if (diags) break;
            }
        }
    }

    if (!diags) return undefined;

    const filtered = diags.filter(isErrorOrWarning);
    if (filtered.length === 0) return undefined;

    const shown = filtered.slice(0, MAX_DIAGNOSTICS).map(formatOne);
    const more = filtered.length > MAX_DIAGNOSTICS
        ? `\n  ...and ${filtered.length - MAX_DIAGNOSTICS} more`
        : '';
    const rel = path.relative(process.env['WORKING_DIR'] ?? process.cwd(), absPath) || path.basename(absPath);

    return `Diagnostics for ${rel} (${filtered.length}):\n${shown.join('\n')}${more}`;
}

async function tryWorkspaceDiagnostics(
    client: LspClient,
    editedAbs: string,
): Promise<string | undefined> {
    const dp = client.capabilities?.diagnosticProvider;
    const supportsWorkspace = typeof dp === 'object'
        && (dp as { workspaceDiagnostics?: boolean }).workspaceDiagnostics === true;
    if (!supportsWorkspace) return undefined;

    type WsItem = { kind?: string; uri: string; items?: Diagnostic[] };
    type WsReport = { items?: WsItem[] };

    let report: WsReport | undefined;
    try {
        report = await client.sendRequest<unknown, WsReport>(
            WorkspaceDiagnosticRequest.type,
            { previousResultIds: [] },
        );
    } catch {
        return undefined;
    }
    if (!report.items) return undefined;

    const byFile = new Map<string, Diagnostic[]>();
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const it of report.items) {
        if (it.kind && it.kind !== 'full') continue;
        if (!it.items || it.items.length === 0) continue;

        const abs = path.resolve(uriToFilePath(it.uri));
        const isEdited = abs === editedAbs;

        const keep = it.items.filter((d) => {
            if (d.severity === DiagnosticSeverity.Error) return true;
            if (isEdited && d.severity === DiagnosticSeverity.Warning) return true;

            return false;
        });
        if (keep.length === 0) continue;

        for (const d of keep) {
            if (d.severity === DiagnosticSeverity.Error) totalErrors++;
            else if (d.severity === DiagnosticSeverity.Warning) totalWarnings++;
        }
        byFile.set(abs, keep);
    }

    if (byFile.size === 0) return undefined;

    const ordered = Array.from(byFile.keys()).sort((a, b) => {
        if (a === editedAbs && b !== editedAbs) return -1;
        if (b === editedAbs && a !== editedAbs) return 1;

        return a.localeCompare(b);
    });

    const headerCounts = [
        `${totalErrors} error${totalErrors === 1 ? '' : 's'}`,
        totalWarnings > 0 ? `${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', ');

    const lines: string[] = [`Diagnostics for project (${headerCounts}):`];
    let shown = 0;
    let truncated = 0;

    for (const f of ordered) {
        const rel = path.relative(process.env['WORKING_DIR'] ?? process.cwd(), f) || path.basename(f);
        const fileLines: string[] = [];

        for (const d of byFile.get(f) ?? []) {
            if (shown >= MAX_WORKSPACE_DIAGNOSTICS) {
                truncated++;
                continue;
            }
            fileLines.push(`    ${formatOne(d).trimStart()}`);
            shown++;
        }

        if (fileLines.length > 0) {
            lines.push(`  ${rel}:`);
            lines.push(...fileLines);
        }
    }

    if (truncated > 0) lines.push(`  ...and ${truncated} more.`);

    return lines.join('\n');
}

function uriToFilePath(uri: string): string {
    if (uri.startsWith('file://')) {
        try {
            return decodeURIComponent(new URL(uri).pathname);
        } catch {
            return uri.slice(7);
        }
    }

    return uri;
}

/**
 * Single public entry point used by the post-edit `withDiagnostics()` hook.
 * Routes through the cheapest source that can answer for `filePath` — see
 * the file-level docstring for the full preference order. Never throws.
 */
export async function getProjectDiagnostics(filePath: string): Promise<string | undefined> {
    const absPath = path.resolve(filePath);

    let registry;
    try {
        registry = await getLspRegistry();
    } catch {
        registry = undefined;
    }

    const hasServer = registry ? registry.hasServerFor(absPath) : false;

    if (hasServer && registry) {
        let client;
        try {
            client = await registry.getClientFor(absPath);
        } catch {
            client = undefined;
        }

        if (client) {
            try {
                await client.refreshFile(absPath);
                await client.openFile(absPath);
            } catch {
                // proceed; workspace diagnostics may still work
            }

            const ws = await tryWorkspaceDiagnostics(client, absPath);
            if (ws) return ws;
        }
    }

    if (isTsLikeFile(absPath)) {
        try {
            const proj = getDiagnosticsForProject(absPath);
            if (proj) return proj;
        } catch {
            // fall through to single-file fallback
        }

        try {
            return getDiagnosticsForFile(absPath);
        } catch {
            return undefined;
        }
    }

    if (hasServer) {
        try {
            return await getLspDiagnosticsForFile(absPath);
        } catch {
            return undefined;
        }
    }

    return undefined;
}

