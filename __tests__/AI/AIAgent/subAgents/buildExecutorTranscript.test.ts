import { buildExecutorTranscriptBlocks } from '@/AI/AIAgent/shared/subAgents/buildExecutorTranscript';
import { createOrchestratorTranscript, type TranscriptEntry } from '@/AI/AIAgent/shared/main/orchestratorTranscript';

describe('createOrchestratorTranscript', () => {
    it('returns all entries when no execute call has been recorded', () => {
        const t = createOrchestratorTranscript();

        t.appendUser('hi');
        t.appendAssistant('thinking…');
        t.appendToolCall({ toolName: 'read_lines', args: { file_path: 'a.ts' }, result: 'L1', success: true });

        const slice = t.sliceSinceLastExecute();

        expect(slice).toHaveLength(3);
        expect(slice[0]).toEqual({ kind: 'user', text: 'hi' });
    });

    it('slices to entries appended after the last execute tool call', () => {
        const t = createOrchestratorTranscript();

        t.appendUser('first task');
        t.appendToolCall({ toolName: 'read_lines', args: {}, result: 'r1', success: true });
        t.appendToolCall({ toolName: 'execute', args: { plan: 'do thing' }, result: 'done', success: true });
        t.appendAssistant('after the first execute');
        t.appendToolCall({ toolName: 'get_outline', args: { file_path: 'b.ts' }, result: 'outline', success: true });

        const slice = t.sliceSinceLastExecute();

        expect(slice).toHaveLength(2);
        expect(slice[0]).toEqual({ kind: 'assistant', text: 'after the first execute' });
        expect(slice[1]?.kind).toBe('tool_call');
    });

    it('matches MCP-prefixed execute tool names (Copilot provider)', () => {
        const t = createOrchestratorTranscript();

        t.appendUser('before');
        t.appendToolCall({ toolName: 'kra-subagent__execute', args: {}, result: 'done', success: true });
        t.appendAssistant('after');

        expect(t.sliceSinceLastExecute()).toEqual([{ kind: 'assistant', text: 'after' }]);
    });

    it('skips empty/whitespace-only user and assistant entries', () => {
        const t = createOrchestratorTranscript();

        t.appendUser('   ');
        t.appendAssistant('\n\n');
        t.appendUser('real');

        expect(t.all()).toEqual([{ kind: 'user', text: 'real' }]);
    });
});

describe('buildExecutorTranscriptBlocks', () => {
    it('renders empty markers when slice is empty', () => {
        const out = buildExecutorTranscriptBlocks([]);

        expect(out).toContain('<orchestrator_investigations>');
        expect(out).toContain('(none)');
        expect(out).toContain('<orchestrator_chat>');
        expect(out).toContain('(no prior conversation captured)');
    });

    it('promotes investigate calls into the investigations block and out of chat', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'user', text: 'find the bug' },
            { kind: 'tool_call', toolName: 'investigate', args: { query: 'where is X handled?' }, result: 'X is handled in foo.ts', success: true },
            { kind: 'assistant', text: 'investigating now' },
        ];

        const out = buildExecutorTranscriptBlocks(slice);

        // Investigations block contains the investigate result and query.
        const investigations = section(out, 'orchestrator_investigations');

        expect(investigations).toContain('where is X handled?');
        expect(investigations).toContain('X is handled in foo.ts');

        // Chat block contains user + assistant but NOT the investigate result.
        const chat = section(out, 'orchestrator_chat');

        expect(chat).toContain('find the bug');
        expect(chat).toContain('investigating now');
        expect(chat).not.toContain('X is handled in foo.ts');
    });

    it('keeps kra-file-context tool calls in chat with verbatim results', () => {
        const fullFile = 'line 1\nline 2\n'.repeat(2000);
        const slice: TranscriptEntry[] = [
            { kind: 'user', text: 'read foo.ts' },
            { kind: 'tool_call', toolName: 'read_lines', args: { file_path: 'foo.ts' }, result: fullFile, success: true },
        ];

        const out = buildExecutorTranscriptBlocks(slice);
        const chat = section(out, 'orchestrator_chat');

        expect(chat).toContain('[tool read_lines');
        expect(chat).toContain('foo.ts');
        expect(chat).toContain(fullFile);
    });

    it('filters out unrelated tool families (web_*, ask_user, ask_kra, sub-agents)', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'tool_call', toolName: 'web_search', args: { query: 'foo' }, result: 'WEB RESULT', success: true },
            { kind: 'tool_call', toolName: 'web_fetch', args: { url: 'http://x' }, result: 'PAGE', success: true },
            { kind: 'tool_call', toolName: 'ask_user', args: { question: 'q' }, result: 'a', success: true },
            { kind: 'tool_call', toolName: 'ask_kra', args: {}, result: '', success: true },
            { kind: 'tool_call', toolName: 'execute', args: {}, result: 'sub-agent ran', success: true },
            { kind: 'tool_call', toolName: 'get_outline', args: { file_path: 'a.ts' }, result: 'KEEP_THIS', success: true },
        ];

        const out = buildExecutorTranscriptBlocks(slice);

        expect(out).toContain('KEEP_THIS');
        expect(out).not.toContain('WEB RESULT');
        expect(out).not.toContain('PAGE');
        expect(out).not.toContain('sub-agent ran');
    });

    it('matches MCP-prefixed tool names from the Copilot provider', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'tool_call', toolName: 'kra-file-context__read_lines', args: { file_path: 'foo.ts' }, result: 'CONTENT_A', success: true },
            { kind: 'tool_call', toolName: 'kra-file-context-search', args: { content_pattern: 'foo' }, result: 'CONTENT_B', success: true },
            { kind: 'tool_call', toolName: 'kra-investigator__investigate', args: { query: 'q' }, result: 'INV_RESULT', success: true },
        ];

        const out = buildExecutorTranscriptBlocks(slice);

        expect(section(out, 'orchestrator_chat')).toContain('CONTENT_A');
        expect(section(out, 'orchestrator_chat')).toContain('CONTENT_B');
        expect(section(out, 'orchestrator_investigations')).toContain('INV_RESULT');
    });

    it('preserves chronological order within the chat block', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'user', text: '__MARK_A__' },
            { kind: 'assistant', text: '__MARK_B__' },
            { kind: 'tool_call', toolName: 'read_lines', args: {}, result: '__MARK_C__', success: true },
            { kind: 'assistant', text: '__MARK_D__' },
        ];

        const chat = section(buildExecutorTranscriptBlocks(slice), 'orchestrator_chat');
        const idxA = chat.indexOf('__MARK_A__');
        const idxB = chat.indexOf('__MARK_B__');
        const idxC = chat.indexOf('__MARK_C__');
        const idxD = chat.indexOf('__MARK_D__');

        expect(idxA).toBeLessThan(idxB);
        expect(idxB).toBeLessThan(idxC);
        expect(idxC).toBeLessThan(idxD);
    });

    it('marks failed tool calls', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'tool_call', toolName: 'read_lines', args: { file_path: 'missing.ts' }, result: 'ENOENT', success: false },
        ];

        const chat = section(buildExecutorTranscriptBlocks(slice), 'orchestrator_chat');

        expect(chat).toContain('FAILED');
        expect(chat).toContain('ENOENT');
    });

    it('pretty-prints investigate results when the JSON shape is recognised', () => {
        const investigationJson = JSON.stringify({
            summary: 'The chat starts at src/main.ts.',
            confidence: 'high',
            evidence: [
                {
                    path: 'src/main.ts',
                    lines: [10, 25],
                    excerpt: 'function main() {\n  startChat();\n}',
                    why_relevant: 'CLI entry point',
                },
            ],
        });
        const slice: TranscriptEntry[] = [
            { kind: 'tool_call', toolName: 'investigate', args: { query: 'where does the chat start?' }, result: investigationJson, success: true },
        ];

        const investigations = section(buildExecutorTranscriptBlocks(slice), 'orchestrator_investigations');

        expect(investigations).toContain('confidence: high');
        expect(investigations).toContain('summary:');
        expect(investigations).toContain('The chat starts at src/main.ts.');
        expect(investigations).toContain('evidence:');
        expect(investigations).toContain('[1] src/main.ts:10-25');
        expect(investigations).toContain('CLI entry point');
        expect(investigations).toContain('      function main() {');
        expect(investigations).not.toContain('"summary":');
    });

    it('falls back to raw output when investigate result is not parseable JSON', () => {
        const slice: TranscriptEntry[] = [
            { kind: 'tool_call', toolName: 'investigate', args: { query: 'q' }, result: 'plain text result', success: true },
        ];

        const investigations = section(buildExecutorTranscriptBlocks(slice), 'orchestrator_investigations');

        expect(investigations).toContain('result:');
        expect(investigations).toContain('plain text result');
    });
});

function section(out: string, tag: string): string {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = out.indexOf(open);
    const end = out.indexOf(close);

    if (start < 0 || end < 0) return '';

    return out.slice(start, end + close.length);
}
