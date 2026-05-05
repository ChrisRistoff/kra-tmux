import { buildOrchestratorSystemMessage } from '@/AI/AIAgent/shared/main/agentConversation';

describe('buildOrchestratorSystemMessage', () => {
    it('always includes turn_completion, workspace, reading_code, surgical_edits, creating_files, long_term_memory', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: false, executeEnabled: false, isCopilot: true });

        expect(out).toContain('<turn_completion');
        expect(out).toContain('<workspace>');
        expect(out).toContain('<reading_code>');
        expect(out).toContain('<surgical_edits>');
        expect(out).toContain('<creating_files>');
        expect(out).toContain('<long_term_memory');
        expect(out).toContain('Reminder: Always call confirm_task_complete');
    });

    it('omits the delegation block when no sub-agents are enabled', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: false, executeEnabled: false });

        expect(out).not.toContain('<delegation');
        expect(out).not.toContain('`investigate`');
        expect(out).not.toContain('`execute`');
        expect(out).not.toContain('Before raw reads, check if delegation');
        expect(out).not.toContain("prefer delegating to `execute`");
    });

    it('uses the original semantic_search-first discovery rule when investigate is disabled', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: false, executeEnabled: false });

        expect(out).toContain("start with `semantic_search({ query, scope: 'both', memoryKind: 'findings' })`");
        expect(out).not.toContain('start with `investigate`');
    });

    it('includes only investigate guidance when only investigate is enabled', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: true, executeEnabled: false });

        expect(out).toContain('<delegation');
        expect(out).toContain('`investigate`');
        expect(out).not.toContain('- `execute`');
        expect(out).toContain('Only ONE investigate can run at a time');
        expect(out).toContain('start with `investigate`');
        expect(out).toContain('Before raw reads, check if delegation');
        expect(out).not.toContain("prefer delegating to `execute`");
    });

    it('includes only execute guidance when only execute is enabled', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: false, executeEnabled: true });

        expect(out).toContain('<delegation');
        expect(out).toContain('`execute`');
        expect(out).not.toContain('- `investigate`');
        expect(out).toContain('Only ONE execute can run at a time');
        expect(out).toContain('a transcript of your prior file reads and reasoning since the last execute');
        expect(out).not.toContain('a transcript of your prior `investigate` calls');
        expect(out).toContain("prefer delegating to `execute`");
        expect(out).toContain("start with `semantic_search");
        expect(out).toContain('needs_decision');
    });

    it('includes both sub-agents and the combined transcript note when both are enabled', () => {
        const out = buildOrchestratorSystemMessage({ investigateEnabled: true, executeEnabled: true });

        expect(out).toContain('- `investigate`');
        expect(out).toContain('- `execute`');
        expect(out).toContain('a transcript of your prior `investigate` calls, file reads, and reasoning');
        expect(out).toContain('Only ONE investigate and ONE execute can run at a time');
        expect(out).toContain('Before raw reads, check if delegation');
        expect(out).toContain("prefer delegating to `execute`");
        expect(out).toContain('needs_decision');
    });
});