/**
 * Bridge between the post-edit `withDiagnostics()` hook in
 * fileContextMcpServer.ts and the generic LSP layer.
 *
 * For any file with a configured language server, asks that server for
 * diagnostics (errors + warnings) using pull mode (`textDocument/diagnostic`)
 * if the server advertises a diagnosticProvider, falling back to push mode
 * (cached `publishDiagnostics`) with a short timed wait otherwise.
 *
 * Output format mirrors the legacy in-process TS diagnostics formatter so
 * downstream rendering is identical.
 */

import * as path from 'path';
import { getLspRegistry } from './lspRegistry';
import { fileUri } from './lspClient';
import {
    DocumentDiagnosticRequest,
    Diagnostic,
    DiagnosticSeverity,
} from 'vscode-languageserver-protocol/node.js';

const DEFAULT_PUSH_WAIT_MS = 800;
const MAX_DIAGNOSTICS = 20;

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
 * Returns a formatted diagnostics block for the file, or undefined when the
 * file has no configured server, the server can't be reached, or the file
 * has no error/warning diagnostics.
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
    const rel = path.relative(process.cwd(), absPath) || path.basename(absPath);

    return `Diagnostics for ${rel} (${filtered.length}):\n${shown.join('\n')}${more}`;
}
