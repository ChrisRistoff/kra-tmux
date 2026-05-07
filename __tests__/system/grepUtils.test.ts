import { EventEmitter } from 'events';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as bash from '@/utils/bashHelper';
import * as grepUtils from '@/system/utils/grepUtils';

jest.mock('@/utils/bashHelper');
const mockExecCommand = jest.mocked(bash.execCommand);

jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return { ...actual, spawn: jest.fn() };
});
const mockSpawn = jest.mocked(childProcess.spawn);

function fakeChild(stdout: string): childProcess.ChildProcess {
    const child = new EventEmitter() as childProcess.ChildProcess & { kill: jest.Mock };
    const out = new EventEmitter() as NodeJS.ReadableStream & { setEncoding: jest.Mock };
    out.setEncoding = jest.fn();
    const err = new EventEmitter() as NodeJS.ReadableStream;
    (child as unknown as { stdout: NodeJS.ReadableStream }).stdout = out;
    (child as unknown as { stderr: NodeJS.ReadableStream }).stderr = err;
    child.kill = jest.fn();
    setImmediate(() => {
        out.emit('data', stdout);
        out.emit('end');
        child.emit('close', 0);
    });
    return child;
}

// helpers
function makeFile(displayPath: string, matchCount = 0, matches: string[] = []): grepUtils.GrepResult {
    return {
        displayPath,
        absPath: path.resolve('/workspace', displayPath),
        type: 'file',
        matchCount,
        matches,
        selected: false,
    };
}

function makeDir(displayPath: string): grepUtils.GrepResult {
    return {
        displayPath,
        absPath: path.resolve('/workspace', displayPath),
        type: 'dir',
        matchCount: 0,
        matches: [],
        selected: false,
    };
}

describe('grepUtils', () => {
    beforeEach(() => jest.clearAllMocks());

    // ─── searchByName ──────────────────────────────────────────────────────────

    describe('searchByName', () => {
        it('returns empty array for blank query', async () => {
            const result = await grepUtils.searchByName('   ', 'f', '/workspace');
            expect(result).toEqual([]);
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('parses rg output into GrepResult array (files)', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild('./src/foo.ts\n./src/bar.ts\n'));
            const results = await grepUtils.searchByName('foo', 'f', '/workspace');
            expect(results).toHaveLength(2);
            expect(results[0].displayPath).toBe('./src/foo.ts');
            expect(results[0].type).toBe('file');
            expect(results[0].absPath).toBe(path.resolve('/workspace', './src/foo.ts'));
            expect(results[0].matchCount).toBe(0);
            expect(results[0].selected).toBe(false);
            expect(mockSpawn.mock.calls[0][0]).toBe('rg');
        });

        it('parses find output into GrepResult array (dirs)', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild('./node_modules\n./dist\n'));
            const results = await grepUtils.searchByName('node', 'd', '/workspace');
            expect(results[0].type).toBe('dir');
            expect(results[1].type).toBe('dir');
            expect(mockSpawn.mock.calls[0][0]).toBe('find');
        });

        it('filters out empty lines', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild('./a.ts\n\n./b.ts\n\n'));
            const results = await grepUtils.searchByName('ts', 'f', '/workspace');
            expect(results).toHaveLength(2);
        });

        it('passes query as glob argument (no shell interpolation)', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild(''));
            await grepUtils.searchByName("foo'bar\"baz\\qux", 'f', '/workspace');
            const args = mockSpawn.mock.calls[0][1] as string[];
            const glob = args.find((a) => a.startsWith('*') && a.endsWith('*'));
            expect(glob).toBe("*foo'bar\"baz\\qux*");
        });

        it('returns empty array when stdout is empty', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild(''));
            const result = await grepUtils.searchByName('nothing', 'f', '/workspace');
            expect(result).toEqual([]);
        });
    });

    // ─── searchContent ────────────────────────────────────────────────────────

    describe('searchContent', () => {
        it('returns empty array for blank query', async () => {
            const result = await grepUtils.searchContent('', '/workspace');
            expect(result).toEqual([]);
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('returns empty array when rg finds no matches', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild(''));
            const result = await grepUtils.searchContent('needle', '/workspace');
            expect(result).toEqual([]);
            expect(mockSpawn).toHaveBeenCalledTimes(1);
        });

        it('parses `rg -l` files-with-matches output (lazy match loading)', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild('src/a.ts\nsrc/b.ts\n'));

            const results = await grepUtils.searchContent('needle', '/workspace');

            expect(results).toHaveLength(2);
            expect(results[0].displayPath).toBe('./src/a.ts');
            // Matches and counts are loaded lazily by loadPreview.
            expect(results[0].matches).toEqual([]);
            expect(results[1].displayPath).toBe('./src/b.ts');
            expect(results[1].matches).toEqual([]);
        });

        it('uses rg -l for the search (fastest mode, early-exits per file)', async () => {
            mockSpawn.mockReturnValueOnce(fakeChild(''));
            await grepUtils.searchContent('needle', '/workspace');
            expect(mockSpawn.mock.calls[0][0]).toBe('rg');
            expect(mockSpawn.mock.calls[0][1]).toContain('-l');
        });
    });

    // ─── loadPreview ──────────────────────────────────────────────────────────

    describe('loadPreview', () => {
        it('runs ls -la for directories', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: 'total 0\n', stderr: '' });
            const result = await grepUtils.loadPreview(makeDir('./mydir'), 'dirs');
            expect(result).toBe('total 0\n');
            expect((mockExecCommand.mock.calls[0][0] as string)).toContain('ls -la');
        });

        it('returns "(empty directory)" when ls output is empty', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '' });
            const result = await grepUtils.loadPreview(makeDir('./mydir'), 'dirs');
            expect(result).toBe('(empty directory)');
        });

        it('renders content-mode matches as tagged lines', async () => {
            const r = makeFile('./src/a.ts', 2, ['5:const foo = 1;', '10:foo()']);
            const result = await grepUtils.loadPreview(r, 'content');
            expect(result).toContain('{yellow-fg}5{/yellow-fg}');
            expect(result).toContain('const foo = 1;');
            expect(result).toContain('{yellow-fg}10{/yellow-fg}');
            expect(mockExecCommand).not.toHaveBeenCalled();
        });

        it('runs head for file in files mode', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: 'line1\nline2\n', stderr: '' });
            const result = await grepUtils.loadPreview(makeFile('./a.ts'), 'files');
            expect((mockExecCommand.mock.calls[0][0] as string)).toContain('head');
            expect(result).toBe('line1\nline2\n');
        });

        it('returns "(binary or empty file)" when head output is empty', async () => {
            mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '' });
            const result = await grepUtils.loadPreview(makeFile('./a.ts'), 'files');
            expect(result).toBe('(binary or empty file)');
        });

        it('returns error message when exec rejects', async () => {
            mockExecCommand.mockRejectedValueOnce(new Error('read error'));
            const result = await grepUtils.loadPreview(makeFile('./a.ts'), 'files');
            expect(result).toBe('(could not read file)');
        });
    });

    // ─── loadMeta ─────────────────────────────────────────────────────────────

    describe('loadMeta', () => {
        it('builds meta string with path, dir, size, line count for file', async () => {
            mockExecCommand
                .mockResolvedValueOnce({ stdout: '-rw-r--r-- 1 user staff 1234 Jan 1 foo.ts', stderr: '' }) // ls
                .mockResolvedValueOnce({ stdout: '4.0K\t/workspace/foo.ts', stderr: '' })  // du
                .mockResolvedValueOnce({ stdout: '42 /workspace/foo.ts', stderr: '' });    // wc

            const result = await grepUtils.loadMeta(makeFile('./foo.ts'));
            expect(result).toContain('{cyan-fg}path');
            expect(result).toContain('{cyan-fg}size');
            expect(result).toContain('4.0K');
            expect(result).toContain('{cyan-fg}lines');
            expect(result).toContain('42');
        });

        it('shows match count when matchCount > 0', async () => {
            mockExecCommand
                .mockResolvedValueOnce({ stdout: '-rw-r--r-- 1 user group 100', stderr: '' })
                .mockResolvedValueOnce({ stdout: '1K\t/workspace/foo.ts', stderr: '' })
                .mockResolvedValueOnce({ stdout: '10 /workspace/foo.ts', stderr: '' });

            const r = makeFile('./foo.ts', 5);
            const result = await grepUtils.loadMeta(r);
            expect(result).toContain('{cyan-fg}matches{/cyan-fg}');
            expect(result).toContain('{yellow-fg}5{/yellow-fg}');
        });

        it('does not show line count or matches for directories', async () => {
            mockExecCommand
                .mockResolvedValueOnce({ stdout: 'drwxr-xr-x 2 user group 64', stderr: '' })
                .mockResolvedValueOnce({ stdout: '8.0K\t/workspace/mydir', stderr: '' });

            const result = await grepUtils.loadMeta(makeDir('./mydir'));
            expect(result).not.toContain('{cyan-fg}lines');
            expect(result).not.toContain('{cyan-fg}matches');
            expect(mockExecCommand).toHaveBeenCalledTimes(2); // ls + du, no wc
        });

        it('falls back gracefully when exec rejects', async () => {
            mockExecCommand.mockRejectedValueOnce(new Error('stat failed'));
            const r = makeFile('./foo.ts');
            const result = await grepUtils.loadMeta(r);
            expect(result).toContain('{cyan-fg}path{/cyan-fg}');
            expect(result).toContain(r.absPath);
        });
    });

    // ─── renderRow ────────────────────────────────────────────────────────────

    describe('renderRow', () => {
        it('renders a file row without selection marker', () => {
            const r = makeFile('./src/foo.ts');
            const row = grepUtils.renderRow(r, 'files');
            expect(row).toContain('📄');
            expect(row).toContain('src/foo.ts');
            expect(row).not.toContain('[x]');
        });

        it('renders a directory row', () => {
            const r = makeDir('./dist');
            const row = grepUtils.renderRow(r, 'dirs');
            expect(row).toContain('📁');
            expect(row).toContain('dist');
        });

        it('shows selection marker when selected', () => {
            const r = { ...makeFile('./a.ts'), selected: true };
            const row = grepUtils.renderRow(r, 'files');
            expect(row).toContain('[x]');
        });

        it('shows match count in content mode', () => {
            const r = makeFile('./a.ts', 7);
            const row = grepUtils.renderRow(r, 'content');
            expect(row).toContain('(7)');
        });

        it('does not show match count in files mode even if matchCount > 0', () => {
            const r = makeFile('./a.ts', 7);
            const row = grepUtils.renderRow(r, 'files');
            expect(row).not.toContain('(7)');
        });

        it('strips leading "./" from displayPath', () => {
            const r = makeFile('./src/foo.ts');
            const row = grepUtils.renderRow(r, 'files');
            expect(row).not.toContain('./');
        });

        it('escapes blessed tags in file path', () => {
            const r = makeFile('./src/{bad}path.ts');
            const row = grepUtils.renderRow(r, 'files');
            expect(row).not.toMatch(/\{bad\}/);
            expect(row).toContain('{open}bad{close}');
        });
    });
});
