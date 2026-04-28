import {
    formatConfirmAnswer,
    formatConfirmQuestion,
    formatSubmittedAgentPrompt,
    formatToolArguments,
    formatToolCompletion,
    formatToolDisplayName,
    summarizeToolCall,
} from '@/AI/AIAgent/shared/utils/agentUi';

describe('agentUi helpers', () => {
    it('formats the submitted prompt body without any header', () => {
        expect(formatSubmittedAgentPrompt('  Tell me something interesting.  ')).toBe(
            'Tell me something interesting.\n'
        );
        expect(formatSubmittedAgentPrompt('   ')).toBe('');
    });

    it('formats confirm-task-complete questions and answers', () => {
        expect(formatConfirmQuestion('Continue?', ['Yes', 'No'])).toBe(
            '\n\n---\n**💬 Continue?**\n\n- Yes\n- No\n\n'
        );

        const answer = formatConfirmAnswer('Yes');
        expect(answer).toContain('## 👤 USER PROMPT · ');
        expect(answer.endsWith('Yes\n\n')).toBe(true);
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
