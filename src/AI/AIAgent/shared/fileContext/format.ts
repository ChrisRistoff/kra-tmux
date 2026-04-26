import { formatOutline, getFileOutline } from '../utils/fileOutline';
import { getDiagnosticsForFile } from '../utils/lspDiagnostics';
import { getLspDiagnosticsForFile } from '../utils/lspDiagnosticsBridge';

/**
 * Build a compact outline string for read_function not-found errors so we don't
 * dump hundreds of entries back into the agent's context just to say "missing".
 */
export function formatOutlineForMiss(
    filePath: string,
    outline: Awaited<ReturnType<typeof getFileOutline>>,
    max = 40,
): string {
    if (outline.entries.length <= max) {
        return formatOutline(filePath, outline);
    }

    const truncated = { ...outline, entries: outline.entries.slice(0, max) };

    return `${formatOutline(filePath, truncated)}\n\n  ...and ${outline.entries.length - max} more (showing first ${max}). Use get_outline for the full list.`;
}

// Sum of (end - start + 1) across all requested ranges.
export function totalRequestedLines(starts: number[], ends: number[]): number {
    let total = 0;

    for (let i = 0; i < starts.length; i++) total += Math.max(0, ends[i] - starts[i] + 1);

    return total;
}

/**
 * Append diagnostics (errors + warnings, single-file scope) to an edit
 * summary so the agent sees them in the same turn it made the change.
 *
 * Source order:
 *   1. If the file's extension has a configured LSP server in settings.toml,
 *      ask that server (pull-mode `textDocument/diagnostic`, falling back to
 *      cached push-mode `publishDiagnostics`). This is the same code path
 *      used by editors like VS Code and Neovim.
 *   2. Otherwise (or if the LSP path returned nothing usable), fall back to
 *      the in-process TypeScript Compiler API check for .ts/.js files.
 *
 * Silent no-op when neither path produces diagnostics.
 */
export async function withDiagnostics(filePath: string, summary: string): Promise<string> {
    let diags: string | undefined;

    try {
        diags = await getLspDiagnosticsForFile(filePath);
    } catch {
        // ignore; try the in-process fallback
    }

    if (!diags) {
        try {
            diags = getDiagnosticsForFile(filePath);
        } catch {
            return summary;
        }
    }

    return diags ? `${summary}\n\n${diags}` : summary;
}

/**
 * Render a 1-indexed slice of `lines` with right-padded line numbers.
 * Shared between read_lines (single + multi-range) and read_function so the
 * numbering format stays in lock-step across tools.
 */
export function numberLines(lines: string[], start: number, end: number): string {
    return lines.slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}: ${l}`)
        .join('\n');
}
