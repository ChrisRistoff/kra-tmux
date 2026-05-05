/**
 * Formats an orchestrator transcript slice into the executor's task prompt.
 *
 * Produces three tagged sections:
 *
 *   <orchestrator_investigations>
 *     [Every `investigate` tool call from the slice — pre-digested findings.
 *      Promoted to its own block so the executor knows to trust them heavily.]
 *
 *   <orchestrator_chat>
 *     [Chronological interleave of user messages, assistant reasoning text,
 *      and `kra-file-context` tool calls + their full verbatim results.
 *      `investigate` calls are omitted here (they live in the block above).
 *      Other tool families (web_*, ask_user, sub-agent dispatch, etc.) are
 *      filtered out as noise.]
 *
 * Tool calls are NEVER truncated — the whole point is for the executor to
 * see what the orchestrator already paid to read, so it doesn't re-fetch.
 */

import type { TranscriptEntry } from '@/AI/AIAgent/shared/main/orchestratorTranscript';

const FILE_CONTEXT_TOOLS = new Set([
    'read_lines',
    'get_outline',
    'read_function',
    'search',
    'anchor_edit',
    'create_file',
    'lsp_query',
]);

export function buildExecutorTranscriptBlocks(slice: TranscriptEntry[]): string {
    const investigations: TranscriptEntry[] = [];
    const chronological: TranscriptEntry[] = [];

    for (const entry of slice) {
        if (entry.kind === 'tool_call' && isInvestigateToolName(entry.toolName)) {
            investigations.push(entry);
            continue;
        }

        if (entry.kind === 'tool_call' && !isFileContextToolName(entry.toolName)) {
            // Drop unrelated tool families (web_*, ask_user, confirm_task_complete,
            // sub-agent dispatch results, etc.).
            continue;
        }

        chronological.push(entry);
    }

    const sections: string[] = [];

    sections.push(formatInvestigationsBlock(investigations));
    sections.push(formatChatBlock(chronological));

    return sections.join('\n\n');
}

function formatInvestigationsBlock(entries: TranscriptEntry[]): string {
    const lines: string[] = ['<orchestrator_investigations>'];

    if (entries.length === 0) {
        lines.push('(none)');
    } else {
        lines.push(
            'Pre-digested findings from prior `investigate` calls. Trust these',
            'heavily — they were produced by a sub-agent that already searched',
            'and synthesised relevant code.',
            '',
        );

        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];

            if (e.kind !== 'tool_call') continue;

            const query = extractInvestigateQuery(e.args);

            lines.push(`--- Investigation ${i + 1} ---`);

            if (query) {
                lines.push(`query: ${query}`);
            }

            lines.push(...formatInvestigationResult(e.result, e.success));
            lines.push('');
        }
    }

    lines.push('</orchestrator_investigations>');

    return lines.join('\n');
}

function formatChatBlock(entries: TranscriptEntry[]): string {
    const lines: string[] = ['<orchestrator_chat>'];

    if (entries.length === 0) {
        lines.push('(no prior conversation captured)');
    } else {
        lines.push(
            'Chronological log of the conversation that led to this execute call.',
            'Includes the user\'s messages, the orchestrator\'s reasoning, and the',
            'orchestrator\'s file-context tool calls with their full verbatim results.',
            'Treat this as authoritative evidence — do NOT re-read files the',
            'orchestrator already read.',
            '',
        );

        for (const entry of entries) {
            lines.push(...formatChatEntry(entry));
            lines.push('');
        }
    }

    lines.push('</orchestrator_chat>');

    return lines.join('\n');
}

function formatChatEntry(entry: TranscriptEntry): string[] {
    if (entry.kind === 'user') {
        return [`[user]`, entry.text];
    }

    if (entry.kind === 'assistant') {
        return [`[assistant]`, entry.text];
    }

    // tool_call (already filtered to file-context tools)
    const argsJson = safeStringifyArgs(entry.args);
    const header = argsJson
        ? `[tool ${entry.toolName} ${argsJson}]`
        : `[tool ${entry.toolName}]`;
    const status = entry.success ? '' : ' (FAILED)';

    return [`${header}${status}`, entry.result];
}

function isInvestigateToolName(toolName: string): boolean {
    if (toolName === 'investigate') return true;

    return /(^|[\-.]|__)investigate$/.test(toolName);
}

function isFileContextToolName(toolName: string): boolean {
    if (FILE_CONTEXT_TOOLS.has(toolName)) return true;

    for (const t of FILE_CONTEXT_TOOLS) {
        const re = new RegExp(`(^|[\\-.]|__)${t}$`);

        if (re.test(toolName)) return true;
    }

    return false;
}

function extractInvestigateQuery(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const q = (args as Record<string, unknown>)['query'];

    return typeof q === 'string' ? q : undefined;
}

interface ParsedEvidenceItem {
    path?: unknown;
    lines?: unknown;
    excerpt?: unknown;
    why_relevant?: unknown;
}

interface ParsedInvestigationResult {
    summary?: unknown;
    evidence?: unknown;
    confidence?: unknown;
}

function formatInvestigationResult(raw: string, success: boolean): string[] {
    if (!success) {
        return ['result (FAILED):', raw];
    }

    const parsed = tryParseJson(raw);

    if (!parsed || typeof parsed !== 'object') {
        return ['result:', raw];
    }

    const r = parsed as ParsedInvestigationResult;
    const out: string[] = [];

    if (typeof r.confidence === 'string' && r.confidence) {
        out.push(`confidence: ${r.confidence}`);
    }

    if (typeof r.summary === 'string' && r.summary) {
        out.push('summary:', r.summary);
    }

    if (Array.isArray(r.evidence) && r.evidence.length > 0) {
        out.push('evidence:');

        for (let i = 0; i < r.evidence.length; i++) {
            const item = r.evidence[i] as ParsedEvidenceItem;
            const path = typeof item.path === 'string' ? item.path : '<unknown path>';
            const lineRange = formatEvidenceLines(item.lines);
            const why = typeof item.why_relevant === 'string' ? item.why_relevant : '';
            const header = `  [${i + 1}] ${path}${lineRange ? `:${lineRange}` : ''}${why ? `  — ${why}` : ''}`;

            out.push(header);

            if (typeof item.excerpt === 'string' && item.excerpt) {
                for (const line of item.excerpt.split('\n')) {
                    out.push(`      ${line}`);
                }
            }
        }
    } else if (Array.isArray(r.evidence)) {
        out.push('evidence: (none returned)');
    }

    if (out.length === 0) {
        return ['result:', raw];
    }

    return out;
}

function formatEvidenceLines(lines: unknown): string {
    if (typeof lines === 'string') return lines;

    if (Array.isArray(lines) && lines.length === 2) {
        return `${lines[0]}-${lines[1]}`;
    }

    if (typeof lines === 'number') return String(lines);

    return '';
}

function tryParseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function safeStringifyArgs(args: unknown): string {
    if (args === null || args === undefined) return '';

    try {
        const json = JSON.stringify(args);

        if (json === '{}') return '';

        return json;
    } catch {
        return '';
    }
}
