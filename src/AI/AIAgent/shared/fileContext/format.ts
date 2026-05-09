import { formatOutline, getFileOutline } from '../utils/fileOutline';
import { getProjectDiagnostics } from '../utils/lspDiagnosticsBridge';

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
 * Append diagnostics to an edit summary so the agent sees them in the same
 * turn it made the change — no need for it to run `tsc` / `npm run build` /
 * `cargo check` / `go build` etc. separately. Routing happens inside
 * `getProjectDiagnostics`; see lspDiagnosticsBridge.ts for the source order.
 */
export async function withDiagnostics(filePath: string, summary: string): Promise<string> {
    const diags = await getProjectDiagnostics(filePath);

    return diags ? `${summary}\n\n${diags}` : summary;
}

/**
 * Render a 1-indexed slice of `lines` as raw text. Line numbers are surfaced
 * via the surrounding header (`Lines X\u2013Y:`) only — callers don't need
 * per-line prefixes since `anchor_edit` is content-addressed (anchors must
 * match the file verbatim) and line numbers would just be noise.
 */
export function numberLines(lines: string[], start: number, end: number): string {
    return lines.slice(start - 1, end).join('\n');
}
