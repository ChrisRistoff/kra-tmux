import { coerceResult, formatExecutionResult } from '@/AI/AIAgent/shared/subAgents/executeTool';

describe('executeTool.coerceResult', () => {
    it('parses a complete result', () => {
        const parsed = coerceResult({
            status: 'completed',
            summary: 'Did the thing.',
            events: [
                { kind: 'edit', detail: 'edited foo.ts', path: 'src/foo.ts', diff: '@@ -1 +1 @@' },
                { kind: 'read', detail: 'read bar.ts' },
            ],
        });

        expect(parsed.status).toBe('completed');
        expect(parsed.summary).toBe('Did the thing.');
        expect(parsed.events).toHaveLength(2);
        expect(parsed.events[0]).toEqual({
            kind: 'edit',
            detail: 'edited foo.ts',
            path: 'src/foo.ts',
            diff: '@@ -1 +1 @@',
        });
        expect(parsed.events[1]).toEqual({ kind: 'read', detail: 'read bar.ts' });
    });

    it('falls back to a sensible default when status is missing or invalid', () => {
        const missing = coerceResult({ summary: 'hi', events: [] }).status;
        const invalid = coerceResult({ status: 'random-junk', summary: 'hi', events: [] }).status;

        expect(['completed', 'partial', 'blocked', 'needs_replan']).toContain(missing);
        expect(['completed', 'partial', 'blocked', 'needs_replan']).toContain(invalid);
        expect(missing).toBe(invalid);
    });

    it('accepts every documented status value', () => {
        for (const s of ['completed', 'partial', 'blocked', 'needs_replan']) {
            expect(coerceResult({ status: s, summary: '', events: [] }).status).toBe(s);
        }
    });

    it('drops events with missing kind or detail', () => {
        const parsed = coerceResult({
            status: 'completed',
            summary: 's',
            events: [
                { kind: 'edit', detail: 'ok' },
                { kind: 'edit' },
                { detail: 'ok' },
                'garbage',
            ],
        });

        expect(parsed.events).toHaveLength(1);
        expect(parsed.events[0]?.kind).toBe('edit');
    });

    it('falls back to empty events array when events is missing', () => {
        const parsed = coerceResult({ status: 'partial', summary: 's' });

        expect(parsed.events).toEqual([]);
    });

    it('captures blockers and replanReason when present', () => {
        const blocked = coerceResult({
            status: 'blocked',
            summary: 's',
            events: [],
            blockers: ['cannot read x', 'permission denied y', 42],
        });

        expect(blocked.blockers).toEqual(['cannot read x', 'permission denied y']);

        const replan = coerceResult({
            status: 'needs_replan',
            summary: 's',
            events: [],
            replanReason: 'plan step 3 is impossible',
        });

        expect(replan.replanReason).toBe('plan step 3 is impossible');
    });
});

describe('executeTool.formatExecutionResult', () => {
    it('renders status, summary, and events as readable text', () => {
        const out = formatExecutionResult({
            status: 'completed',
            summary: 'All done.',
            events: [
                { kind: 'edit', detail: 'edited foo.ts', path: 'src/foo.ts' },
                { kind: 'read', detail: 'read bar.ts' },
            ],
        });

        expect(out).toContain('completed');
        expect(out).toContain('All done.');
        expect(out).toContain('edit src/foo.ts');
        expect(out).toContain('edited foo.ts');
        expect(out).toContain('read');
        expect(out).toContain('read bar.ts');
    });

    it('truncates inline diffs to 80 lines', () => {
        const longDiff = Array.from({ length: 200 }, (_, i) => `+ line ${i}`).join('\n');
        const out = formatExecutionResult({
            status: 'completed',
            summary: 's',
            events: [
                { kind: 'edit', detail: 'huge', path: 'a.ts', diff: longDiff },
            ],
        });

        const renderedDiffLines = out.split('\n').filter((l) => l.includes('+ line '));

        expect(renderedDiffLines.length).toBeLessThanOrEqual(80);
        expect(renderedDiffLines[0]).toContain('+ line 0');
    });

    it('renders blockers when status = blocked', () => {
        const out = formatExecutionResult({
            status: 'blocked',
            summary: 's',
            events: [],
            blockers: ['needs missing config', 'tsc error in unrelated file'],
        });

        expect(out).toContain('blocked');
        expect(out).toContain('needs missing config');
        expect(out).toContain('tsc error in unrelated file');
    });

    it('renders replanReason when status = needs_replan', () => {
        const out = formatExecutionResult({
            status: 'needs_replan',
            summary: 's',
            events: [],
            replanReason: 'plan does not account for X',
        });

        expect(out).toContain('needs_replan');
        expect(out).toContain('plan does not account for X');
    });
});
