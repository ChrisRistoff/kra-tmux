import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { coerceResult, validateEvidence } from '@/AI/AIAgent/shared/subAgents/investigateTool';

describe('investigateTool.coerceResult', () => {
    it('parses a complete result', () => {
        const parsed = coerceResult({
            summary: 'foo handles X',
            evidence: [
                {
                    path: 'src/foo.ts',
                    lines: '12-20',
                    excerpt: 'function foo() {}',
                    why_relevant: 'entry point',
                },
            ],
            confidence: 'high',
            suggested_next: 'look at bar.ts',
        });

        expect(parsed.summary).toBe('foo handles X');
        expect(parsed.evidence).toHaveLength(1);
        expect(parsed.evidence[0]?.path).toBe('src/foo.ts');
        expect(parsed.confidence).toBe('high');
        expect(parsed.suggested_next).toBe('look at bar.ts');
    });

    it('falls back to a sensible default when confidence is missing or invalid', () => {
        const missing = coerceResult({ summary: '', evidence: [] }).confidence;
        const invalid = coerceResult({ summary: '', evidence: [], confidence: 'unknown' }).confidence;

        expect(['high', 'medium', 'low']).toContain(missing);
        expect(['high', 'medium', 'low']).toContain(invalid);
        expect(missing).toBe(invalid);
    });

    it('drops malformed evidence entries', () => {
        const parsed = coerceResult({
            summary: '',
            evidence: [
                { path: 'a', lines: '1', excerpt: 'x', why_relevant: 'y' },
                { path: 'a' },
                'garbage',
                { path: 'b', lines: '2', excerpt: 'y', why_relevant: 'z' },
            ],
        });

        expect(parsed.evidence).toHaveLength(2);
        expect(parsed.evidence.map((e) => e.path)).toEqual(['a', 'b']);
    });
});

describe('investigateTool.validateEvidence', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'investigate-validate-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('keeps evidence whose excerpt matches the file at the stated range', async () => {
        const file = path.join(tmpDir, 'a.ts');
        await fs.writeFile(file, ['line one', 'line two', 'line three', 'line four'].join('\n'));

        const validated = await validateEvidence(
            [{ path: 'a.ts', lines: '2-3', excerpt: 'line two\nline three', why_relevant: 'mid' }],
            tmpDir,
        );

        expect(validated[0]?.why_relevant).toBe('mid');
        expect(validated[0]?.why_relevant.startsWith('[unverified')).toBe(false);
    });

    it('flags evidence whose excerpt does not match the file', async () => {
        const file = path.join(tmpDir, 'a.ts');
        await fs.writeFile(file, ['line one', 'line two'].join('\n'));

        const validated = await validateEvidence(
            [{ path: 'a.ts', lines: '1-2', excerpt: 'totally different', why_relevant: 'x' }],
            tmpDir,
        );

        expect(validated[0]?.why_relevant).toMatch(/^\[unverified: excerpt does not match/);
    });

    it('flags evidence with a bad line range', async () => {
        const file = path.join(tmpDir, 'a.ts');
        await fs.writeFile(file, 'only line\n');

        const validated = await validateEvidence(
            [{ path: 'a.ts', lines: 'not-a-range', excerpt: 'only line', why_relevant: 'x' }],
            tmpDir,
        );

        expect(validated[0]?.why_relevant).toMatch(/^\[unverified: bad line range/);
    });

    it('flags evidence pointing at a missing file', async () => {
        const validated = await validateEvidence(
            [{ path: 'does/not/exist.ts', lines: '1-1', excerpt: 'x', why_relevant: 'x' }],
            tmpDir,
        );

        expect(validated[0]?.why_relevant).toMatch(/^\[unverified: file not found/);
    });

    it('tolerates whitespace-only differences in the excerpt', async () => {
        const file = path.join(tmpDir, 'a.ts');
        await fs.writeFile(file, 'foo\nbar\n');

        const validated = await validateEvidence(
            [{ path: 'a.ts', lines: '1-2', excerpt: '  foo\n  bar  ', why_relevant: 'x' }],
            tmpDir,
        );

        expect(validated[0]?.why_relevant).toBe('x');
    });
});
