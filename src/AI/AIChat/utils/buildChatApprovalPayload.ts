/**
 * Build the rich payload that drives the chat-TUI approval modal. Mirrors
 * the agent-side `buildToolApprovalDetails` (in `agentToolHook.ts`) but
 * without workspace / write-preview coupling — chat tools are read-only
 * (web_fetch, web_search, docs_search, deep_search, investigate_web).
 *
 * The output shape (`ToolApprovalPayload`) is intentionally generic so the
 * agent can later switch to firing the same blessed modal instead of its
 * lua popup.
 */

import type { ToolApprovalPayload } from '@/AI/TUI/widgets/approvalModal';

function coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function coerceNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: number[] = [];
    for (const v of value) {
        const n = coerceNumber(v);
        if (n === undefined) return undefined;
        out.push(n);
    }
    return out;
}

function summarizeLineRanges(args: Record<string, unknown> | undefined): string | undefined {
    if (!args) return undefined;
    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined;
    const startArr = coerceNumberArray(args.startLines);
    const endArr = coerceNumberArray(args.endLines);

    const ranges: Array<[number, number]> = [];
    if (startArr && endArr && startArr.length === endArr.length && startArr.length > 0) {
        for (let i = 0; i < startArr.length; i++) ranges.push([startArr[i], endArr[i]]);
    } else {
        const s = coerceNumber(args.start_line);
        const e = coerceNumber(args.end_line);
        if (s !== undefined && e !== undefined) ranges.push([s, e]);
    }

    if (!filePath && ranges.length === 0) return undefined;

    const parts: string[] = [];
    if (filePath) parts.push(`File: ${filePath}`);
    if (ranges.length > 0) {
        const total = ranges.reduce((acc, [s, e]) => acc + Math.max(0, e - s + 1), 0);
        const list = ranges
            .map(([s, e]) => (s === e ? `${s}` : `${s}\u2013${e}`))
            .join(', ');
        parts.push(
            `Line ranges: ${list}  (${ranges.length} range${ranges.length === 1 ? '' : 's'}, ${total} line${total === 1 ? '' : 's'})`,
        );
    }
    return parts.join('\n');
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown> | undefined): string {
    if (!args) return 'No arguments.';

    if (toolName.includes('read_lines')) {
        const ranges = summarizeLineRanges(args);
        if (ranges) return ranges;
    }

    if (typeof args.url === 'string') return `URL:\n${args.url}`;
    if (typeof args.command === 'string') return `Command:\n${args.command}`;
    if (typeof args.query === 'string') {
        const q = args.query.length > 400 ? args.query.slice(0, 400) + '\u2026' : args.query;
        return `Query:\n${q}`;
    }
    if (Array.isArray(args.questions) && args.questions.length > 0) {
        const list = (args.questions as unknown[])
            .filter((q): q is string => typeof q === 'string')
            .map((q, i) => `  ${i + 1}. ${q.length > 200 ? q.slice(0, 200) + '\u2026' : q}`)
            .join('\n');
        return `Questions:\n${list}`;
    }
    if (typeof args.path === 'string') return `Path:\n${args.path}`;
    if (typeof args.file_path === 'string') return `File: ${args.file_path}`;

    const keys = Object.keys(args);
    if (keys.length === 0) return 'No arguments.';
    return `Keys: ${keys.join(', ')}`;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
    web_fetch: 'Fetches a single URL and returns the page contents.',
    web_search: 'Runs a web search and returns AI-curated results with citations.',
    docs_search: 'Vector search over the local indexed third-party docs corpus (offline).',
    deep_search: 'Spawns a sub-agent to perform multi-step research over the codebase.',
    investigate_web: 'Spawns a sub-agent that searches the web and synthesises an answer.',
};

export function buildChatApprovalPayload(input: {
    toolName: string,
    toolArgs: unknown,
    agentLabel?: string,
}): ToolApprovalPayload {
    const argsRecord = (input.toolArgs && typeof input.toolArgs === 'object' && !Array.isArray(input.toolArgs))
        ? input.toolArgs as Record<string, unknown>
        : undefined;

    let argsJson: string;
    try {
        argsJson = JSON.stringify(input.toolArgs ?? {}, null, 2);
    } catch {
        argsJson = String(input.toolArgs);
    }

    const summary = summarizeToolArgs(input.toolName, argsRecord);
    const description = TOOL_DESCRIPTIONS[input.toolName] ?? 'External tool call.';

    const detailsParts: string[] = [];
    detailsParts.push(`Tool: ${input.agentLabel ? `[${input.agentLabel}] ` : ''}${input.toolName}`);
    detailsParts.push(`What it does: ${description}`);
    detailsParts.push('');
    detailsParts.push(summary);

    return {
        toolName: input.toolName,
        ...(input.agentLabel ? { agentLabel: input.agentLabel } : {}),
        title: `Approve tool · ${input.agentLabel ? `[${input.agentLabel}] ` : ''}${input.toolName}`,
        summary,
        details: detailsParts.join('\n'),
        argsJson,
        toolArgs: input.toolArgs,
    };
}
