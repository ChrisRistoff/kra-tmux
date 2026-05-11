import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { handleEdit } from '@/AI/AIAgent/shared/fileContext/handlers/edit';

async function makeFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-handler-'));
    const file = path.join(dir, 'sample.txt');
    await fs.writeFile(file, content);

    return file;
}

function textOf(result: { content: { type: string, text: string }[] }): string {
    return result.content.map(c => c.text).join('\n');
}

describe('handleEdit (anchor-based)', () => {
    it('replaces a single-line anchor', async () => {
        const file = await makeFile('a\nb\nc\n');
        const result = await handleEdit(file, {
            edits: [{ op: 'replace', anchor: 'b', content: 'B' }],
        });

        expect(textOf(result)).toMatch(/Replaced/i);
        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nB\nc\n');
    });

    it('replaces a range bounded by anchor + end_anchor', async () => {
        const file = await makeFile('one\ntwo\nthree\nfour\nfive\n');
        await handleEdit(file, {
            edits: [{
                op: 'replace',
                anchor: 'two',
                end_anchor: 'four',
                content: 'X\nY',
            }],
        });

        await expect(fs.readFile(file, 'utf8')).resolves.toBe('one\nX\nY\nfive\n');
    });

    it('inserts content after the anchor by default', async () => {
        const file = await makeFile('a\nb\nc\n');
        await handleEdit(file, {
            edits: [{ op: 'insert', anchor: 'b', content: 'b2' }],
        });

        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nb\nb2\nc\n');
    });

    it('inserts content before the anchor when position=before', async () => {
        const file = await makeFile('a\nb\nc\n');
        await handleEdit(file, {
            edits: [{ op: 'insert', anchor: 'b', position: 'before', content: 'a2' }],
        });

        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\na2\nb\nc\n');
    });

    it('deletes the anchor block', async () => {
        const file = await makeFile('a\nb\nc\n');
        await handleEdit(file, {
            edits: [{ op: 'delete', anchor: 'b' }],
        });

        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nc\n');
    });

    it('rejects an anchor that matches more than once', async () => {
        const file = await makeFile('x\ny\nx\n');
        const result = await handleEdit(file, {
            edits: [{ op: 'replace', anchor: 'x', content: 'X' }],
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/match/i);
        await expect(fs.readFile(file, 'utf8')).resolves.toBe('x\ny\nx\n');
    });

    it('rejects an anchor that does not match', async () => {
        const file = await makeFile('a\nb\nc\n');
        const result = await handleEdit(file, {
            edits: [{ op: 'replace', anchor: 'zzz', content: 'X' }],
        });

        expect(result.isError).toBe(true);
        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nb\nc\n');
    });

    it('rejects a blank anchor', async () => {
        const file = await makeFile('a\nb\nc\n');
        const result = await handleEdit(file, {
            edits: [{ op: 'replace', anchor: '   ', content: 'X' }],
        });

        expect(result.isError).toBe(true);
    });

    it('falls back to a trimmed match when strict matches zero and trimmed matches once', async () => {
        const file = await makeFile('  hello\nworld\n');
        const result = await handleEdit(file, {
            edits: [{ op: 'replace', anchor: 'hello', content: 'HI' }],
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toMatch(/whitespace-trim/i);
        await expect(fs.readFile(file, 'utf8')).resolves.toBe('HI\nworld\n');
    });

    it('applies multiple edits bottom-to-top against the original file', async () => {
        const file = await makeFile('a\nb\nc\nd\ne\n');
        await handleEdit(file, {
            edits: [
                { op: 'replace', anchor: 'b', content: 'B' },
                { op: 'replace', anchor: 'd', content: 'D' },
            ],
        });

        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nB\nc\nD\ne\n');
    });

    it('rejects overlapping edits', async () => {
        const file = await makeFile('a\nb\nc\nd\n');
        const result = await handleEdit(file, {
            edits: [
                { op: 'replace', anchor: 'b', end_anchor: 'd', content: 'X' },
                { op: 'replace', anchor: 'c', content: 'C' },
            ],
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/overlap/i);
        await expect(fs.readFile(file, 'utf8')).resolves.toBe('a\nb\nc\nd\n');
    });

    it('returns an error when the file does not exist', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-handler-'));
        const result = await handleEdit(path.join(dir, 'nope.txt'), {
            edits: [{ op: 'replace', anchor: 'x', content: 'y' }],
        });

        expect(result.isError).toBe(true);
    });
});
