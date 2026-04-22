import {
    extractAgentDraftPrompt,
    formatAgentConversationEntry,
    formatAgentDraftEntry,
    formatToolArguments,
    formatToolCompletion,
    formatToolDisplayName,
    materializeAgentDraft,
    isAgentDraftHeader,
    isAgentUserHeader,
    summarizeToolCall,
} from '@/AI/AIAgent/utils/agentUi';

describe('agentUi helpers', () => {
    it('formats agent conversation headers with model metadata', () => {
        expect(formatAgentConversationEntry('ASSISTANT', {
            model: 'gpt-5.4',
            timestamp: '2026-04-19T11:39:18.702Z',
        })).toBe('\n---\n\n## 🤖 ASSISTANT RESPONSE · gpt-5.4 · 2026-04-19T11:39:18.702Z\n\n');
    });

    it('detects agent user headers', () => {
        expect(isAgentUserHeader('## 👤 USER PROMPT · 2026-04-19T11:39:18.702Z')).toBe(true);
        expect(isAgentUserHeader('### USER (2026-04-19T11:39:18.702Z)')).toBe(false);
    });

    it('uses a distinct draft section for the next prompt', () => {
        expect(formatAgentDraftEntry()).toBe('\n---\n\n## 👤 USER PROMPT (draft)\n\n');
        expect(isAgentDraftHeader('## 👤 USER PROMPT (draft)')).toBe(true);
    });

    it('extracts and materializes the current draft prompt into a user turn', () => {
        const lines = [
            '# Copilot Agent Chat',
            '---',
            '',
            '## 👤 USER PROMPT (draft)',
            '',
            'Tell me something interesting.',
            '',
        ];

        expect(extractAgentDraftPrompt(lines)).toBe('Tell me something interesting.');
        expect(materializeAgentDraft(lines, '2026-04-19T11:49:40.395Z')).toContain(
            '## 👤 USER PROMPT · 2026-04-19T11:49:40.395Z'
        );
        expect(materializeAgentDraft(lines, '2026-04-19T11:49:40.395Z')).toContain(
            'Tell me something interesting.\n'
        );
    });

    it('creates short tool call summaries', () => {
        expect(summarizeToolCall('web_search', { query: 'octopus fun fact site:nationalgeographic.com' })).toBe(
            'web_search: octopus fun fact site:nationalgeographic.com'
        );
    });

    it('formats MCP-backed tool names clearly', () => {
        expect(formatToolDisplayName('bash', 'functions', 'bash')).toBe('functions:bash');
        expect(formatToolDisplayName('edit')).toBe('edit');
    });

    it('renders tool arguments as readable JSON', () => {
        expect(formatToolArguments({ command: 'npm test', initial_wait: 180 })).toBe(
            '{\n  "command": "npm test",\n  "initial_wait": 180\n}'
        );
    });

    it('prefers detailed tool completion output and failure messages', () => {
        expect(formatToolCompletion(true, {
            content: 'short',
            detailedContent: 'detailed output',
        })).toBe('detailed output');

        expect(formatToolCompletion(false, undefined, new Error('tool exploded'))).toBe('tool exploded');
    });
});
