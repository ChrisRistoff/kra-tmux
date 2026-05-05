import { matchesSubAgentWhitelist } from '@/AI/AIAgent/shared/subAgents/whitelist';

describe('matchesSubAgentWhitelist', () => {
    const whitelist = [
        'read_lines',
        'get_outline',
        'anchor_edit',
        'lsp_query',
        'search',
        'submit_result',
    ];

    it('matches bare BYOK tool names', () => {
        expect(matchesSubAgentWhitelist('read_lines', whitelist)).toBe(true);
        expect(matchesSubAgentWhitelist('lsp_query', whitelist)).toBe(true);
        expect(matchesSubAgentWhitelist('submit_result', whitelist)).toBe(true);
    });

    it('matches Copilot dash-prefixed MCP tool names', () => {
        expect(matchesSubAgentWhitelist('kra-file-context-read_lines', whitelist)).toBe(true);
        expect(matchesSubAgentWhitelist('kra-memory-search', whitelist)).toBe(true);
    });

    it('matches Copilot double-underscore-prefixed MCP tool names', () => {
        expect(matchesSubAgentWhitelist('kra-file-context__read_lines', whitelist)).toBe(true);
        expect(matchesSubAgentWhitelist('kra-memory__search', whitelist)).toBe(true);
    });

    it('matches dot-namespaced tool names', () => {
        expect(matchesSubAgentWhitelist('server.read_lines', whitelist)).toBe(true);
    });

    it('rejects tools not in the whitelist', () => {
        expect(matchesSubAgentWhitelist('bash', whitelist)).toBe(false);
        expect(matchesSubAgentWhitelist('confirm_task_complete', whitelist)).toBe(false);
        expect(matchesSubAgentWhitelist('kra-bash-bash', whitelist)).toBe(false);
    });

    it('does NOT match underscore-prefixed lookalikes', () => {
        // critical: read_lines must not match evil_read_lines etc., because we
        // do not split on `_` (real tool names already contain underscores).
        expect(matchesSubAgentWhitelist('evil_read_lines', whitelist)).toBe(false);
        expect(matchesSubAgentWhitelist('not_search', whitelist)).toBe(false);
        expect(matchesSubAgentWhitelist('extra_get_outline', whitelist)).toBe(false);
    });

    it('does not match tools with the whitelist entry as a prefix', () => {
        expect(matchesSubAgentWhitelist('read_lines_extra', whitelist)).toBe(false);
        expect(matchesSubAgentWhitelist('search-things', whitelist)).toBe(false);
    });

    it('handles regex metacharacters in whitelist entries safely', () => {
        // Even if someone configured a pathological tool name with regex-special
        // characters, it should be matched literally and not crash.
        const w = ['weird.tool+name'];

        expect(matchesSubAgentWhitelist('weird.tool+name', w)).toBe(true);
        expect(matchesSubAgentWhitelist('server-weird.tool+name', w)).toBe(true);
        expect(matchesSubAgentWhitelist('weirdAtoolBname', w)).toBe(false);
    });

    it('accepts a Set as whitelist input', () => {
        const set = new Set(['read_lines']);

        expect(matchesSubAgentWhitelist('read_lines', set)).toBe(true);
        expect(matchesSubAgentWhitelist('kra-file-context-read_lines', set)).toBe(true);
        expect(matchesSubAgentWhitelist('bash', set)).toBe(false);
    });
});
