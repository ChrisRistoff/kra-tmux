/**
 * Whitelist matcher for sub-agent tool calls.
 *
 * Sub-agents run with a restricted toolset. Different providers surface MCP
 * tool names with different prefixes:
 *   BYOK    → bare `originalName`              (e.g. `read_lines`)
 *   Copilot → `<server>__<tool>` or `<server>-<tool>` (e.g. `kra-memory-search`,
 *             `kra-file-context__search`)
 *
 * Match if any whitelist entry appears as a trailing segment delimited by
 * `__`, `-`, or `.`. We deliberately do NOT split on `_` because many real
 * tool names (`read_lines`, `lsp_query`, …) contain underscores.
 *
 * Exported separately from `session.ts` so the regex behaviour is unit-testable
 * without having to spin up a sub-agent session.
 */
export function matchesSubAgentWhitelist(toolName: string, whitelist: Iterable<string>): boolean {
    const allowed = new Set(whitelist);

    if (allowed.has(toolName)) {
        return true;
    }

    for (const entry of allowed) {
        const re = new RegExp(`(^|[\\-.]|__)${escapeRegExp(entry)}$`);

        if (re.test(toolName)) {
            return true;
        }
    }

    return false;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
