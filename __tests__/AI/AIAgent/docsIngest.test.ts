import { buildDocChunks, ingestPage, pageHash } from '@/AI/AIAgent/shared/docs/ingest';
import { chunkMarkdown } from '@/AI/AIAgent/shared/docs/chunker';
import { embedMany } from '@/AI/AIAgent/shared/memory/embedder';
import { getDocChunksTable } from '@/AI/AIAgent/shared/memory/db';

jest.mock('@/AI/AIAgent/shared/memory/embedder', () => ({
    embedMany: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
}));

jest.mock('@/AI/AIAgent/shared/memory/db', () => ({
    getDocChunksTable: jest.fn(),
}));

const mockedEmbedMany = jest.mocked(embedMany);
const mockedGetDocChunksTable = jest.mocked(getDocChunksTable);

describe('chunkMarkdown', () => {
    it('preserves heading hierarchy in sectionPath', () => {
        const md = [
            '# Top',
            '',
            'intro paragraph',
            '',
            '## Sub A',
            '',
            'body of sub a',
            '',
            '### Deep',
            '',
            'deep body',
        ].join('\n');
        const chunks = chunkMarkdown(md, { pageTitle: 'Page' });
        expect(chunks.length).toBeGreaterThan(0);
        const paths = chunks.map((c) => c.sectionPath);
        expect(paths.some((p) => p.includes('Top'))).toBe(true);
        expect(paths.some((p) => p.includes('Sub A'))).toBe(true);
        expect(paths.some((p) => p.includes('Deep'))).toBe(true);
        for (const c of chunks) {
            expect(c.contentForEmbedding.startsWith('# ')).toBe(true);
            expect(c.tokenCount).toBeGreaterThan(0);
        }
    });

    it('keeps fenced code blocks atomic even when oversized', () => {
        const big = Array.from({ length: 400 }, (_, i) => `code line ${i}`).join('\n');
        const md = ['# H', '', '```ts', big, '```'].join('\n');
        const chunks = chunkMarkdown(md, { maxTokens: 100 });
        const codeChunk = chunks.find((c) => c.content.includes('```ts'));
        expect(codeChunk).toBeDefined();
        expect(codeChunk!.content).toContain('code line 399');
    });

    it('returns no chunks for empty markdown', () => {
        expect(chunkMarkdown('   \n\n   ')).toEqual([]);
    });
});

describe('buildDocChunks', () => {
    it('produces stable, alias-prefixed ids and propagates section metadata', () => {
        const md = [
            '# Title',
            '',
            'Intro paragraph one.',
            '',
            '## Section One',
            '',
            'Body of section one.',
            '',
            '## Section Two',
            '',
            'Body of section two.',
        ].join('\n');
        const built = buildDocChunks({
            alias: 'lancedb',
            url: 'https://example.com/page',
            title: 'Example',
            markdown: md,
            indexedAt: 1000,
        });

        expect(built.length).toBeGreaterThan(0);
        for (const b of built) {
            expect(b.row.id.startsWith('lancedb:')).toBe(true);
            expect(b.row.sourceAlias).toBe('lancedb');
            expect(b.row.url).toBe('https://example.com/page');
            expect(b.row.indexedAt).toBe(1000);
            expect(b.row.content.length).toBeGreaterThan(0);
            expect(typeof b.row.sectionPath).toBe('string');
            expect(b.row.tokenCount).toBeGreaterThan(0);
            expect(b.contentForEmbedding.length).toBeGreaterThan(b.row.content.length);
        }

        const indices = built.map((b) => b.row.chunkIndex);
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        expect(new Set(indices).size).toBe(indices.length);
    });

    it('returns no chunks for whitespace-only markdown', () => {
        const built = buildDocChunks({
            alias: 'x',
            url: 'https://x',
            title: '',
            markdown: '\n\n   \n',
        });
        expect(built).toEqual([]);
    });
});

describe('pageHash', () => {
    it('is stable for identical inputs and varies with content', () => {
        expect(pageHash('hello')).toBe(pageHash('hello'));
        expect(pageHash('hello')).not.toBe(pageHash('hello world'));
    });
});

describe('ingestPage', () => {
    beforeEach(() => {
        mockedEmbedMany.mockClear();
        mockedGetDocChunksTable.mockReset();
    });

    it('embeds chunks and adds them to an existing table after deleting prior rows for the url', async () => {
        const added: unknown[][] = [];
        let rowCount = 5;
        const fakeTable = {
            add: jest.fn(async (rows: unknown[]) => { added.push(rows); rowCount += rows.length; }),
            delete: jest.fn(async () => { rowCount = Math.max(0, rowCount - 2); }),
            countRows: jest.fn(async () => rowCount),
        };
        mockedGetDocChunksTable.mockResolvedValue({
            table: fakeTable as unknown as Awaited<ReturnType<typeof getDocChunksTable>>['table'],
            justCreated: false,
        });

        const result = await ingestPage({
            alias: 'lancedb',
            url: 'https://example.com/a',
            title: 'A',
            markdown: '# A\n\nhello world\n\nsecond paragraph here\n',
        });

        expect(mockedEmbedMany).toHaveBeenCalledTimes(1);
        expect(fakeTable.delete).toHaveBeenCalledTimes(1);
        expect(fakeTable.add).toHaveBeenCalledTimes(1);
        expect(result.chunksWritten).toBeGreaterThan(0);
        expect(result.chunksDeleted).toBe(2);
        expect(typeof result.pageHash).toBe('string');
        expect(result.pageHash.length).toBe(64);
    });

    it('skips delete and seeds the table on first creation', async () => {
        const fakeTable = {
            add: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
            countRows: jest.fn(async () => 0),
        };
        mockedGetDocChunksTable.mockResolvedValue({
            table: fakeTable as unknown as Awaited<ReturnType<typeof getDocChunksTable>>['table'],
            justCreated: true,
        });

        const result = await ingestPage({
            alias: 'lancedb',
            url: 'https://example.com/b',
            title: 'B',
            markdown: '# B\n\nonly a tiny page',
        });

        expect(fakeTable.delete).not.toHaveBeenCalled();
        expect(result.chunksWritten).toBeGreaterThan(0);
        expect(result.chunksDeleted).toBe(0);
    });

    it('returns zero work for empty markdown', async () => {
        mockedGetDocChunksTable.mockResolvedValue({ table: null, justCreated: false });
        const result = await ingestPage({
            alias: 'x', url: 'https://x', title: '', markdown: '   \n',
        });
        expect(result.chunksWritten).toBe(0);
        expect(mockedEmbedMany).not.toHaveBeenCalled();
    });
});
