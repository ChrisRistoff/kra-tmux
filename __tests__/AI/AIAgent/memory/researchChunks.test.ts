import {
    insertResearchChunks,
    searchResearchChunks,
    deleteByResearchIds,
    deleteResearchChunksOlderThan,
} from '@/AI/AIAgent/shared/memory/researchChunks';
import { getResearchChunksTable } from '@/AI/AIAgent/shared/memory/db';
import type { ResearchChunkRow } from '@/AI/AIAgent/shared/memory/types';

jest.mock('@/AI/AIAgent/shared/memory/db', () => ({
    getResearchChunksTable: jest.fn(),
}));

const mockedGetTable = jest.mocked(getResearchChunksTable);

interface FakeTable {
    add: jest.Mock;
    delete: jest.Mock;
    search: jest.Mock;
    _whereSpy: jest.Mock;
}

function makeTable(searchRows: Record<string, unknown>[] = []): FakeTable {
    const whereSpy = jest.fn();
    const search = jest.fn(() => ({
        where: (filter: string) => {
            whereSpy(filter);
            return {
                limit: jest.fn(() => ({ toArray: jest.fn(async () => searchRows) })),
            };
        },
    }));

    return {
        add: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
        search,
        _whereSpy: whereSpy,
    };
}

function row(overrides: Partial<ResearchChunkRow> = {}): ResearchChunkRow {
    return {
        id: 'cid',
        researchId: 'rid',
        url: 'https://example.com/a',
        title: 'A',
        sectionPath: 'S',
        chunkIndex: 0,
        content: 'body',
        fetchedAt: 1_000,
        vector: [0.1, 0.2, 0.3],
        ...overrides,
    };
}

describe('researchChunks.insertResearchChunks', () => {
    beforeEach(() => jest.clearAllMocks());

    it('is a no-op for an empty batch (does not touch the table)', async () => {
        await insertResearchChunks([]);
        expect(mockedGetTable).not.toHaveBeenCalled();
    });

    it('seeds via the first row and adds the remainder', async () => {
        const table = makeTable();
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: true });

        const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
        await insertResearchChunks(rows);

        expect(mockedGetTable).toHaveBeenCalledWith(rows[0], undefined);
        expect(table.add).toHaveBeenCalledTimes(1);
        expect(table.add.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it('does not call add when only one row is provided (the seed insert covers it)', async () => {
        const table = makeTable();
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: true });

        await insertResearchChunks([row()]);
        expect(table.add).not.toHaveBeenCalled();
    });

    it('throws when the table is unavailable after the seed insert', async () => {
        mockedGetTable.mockResolvedValueOnce({ table: null, justCreated: false });
        await expect(insertResearchChunks([row()])).rejects.toThrow(/research_chunks table unavailable/);
    });
});

describe('researchChunks.searchResearchChunks', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns [] when the table does not exist yet', async () => {
        mockedGetTable.mockResolvedValueOnce({ table: null, justCreated: false });
        const out = await searchResearchChunks({ researchId: 'rid', vector: [0, 0, 0] });
        expect(out).toEqual([]);
    });

    it('applies a researchId filter and (when ttlMs is set) a fetchedAt cutoff', async () => {
        const table = makeTable([
            { ...row({ id: '1' }), _distance: 0 },
        ]);
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        const before = Date.now();
        await searchResearchChunks({ researchId: 'rid-1', vector: [0.1], k: 4, ttlMs: 60_000 });
        const after = Date.now();

        expect(table._whereSpy).toHaveBeenCalledTimes(1);
        const filter = table._whereSpy.mock.calls[0]?.[0] as string;
        expect(filter).toContain("researchId = 'rid-1'");
        expect(filter).toMatch(/fetchedAt > \d+/);
        const cutoff = Number(filter.match(/fetchedAt > (\d+)/)?.[1]);
        expect(cutoff).toBeGreaterThanOrEqual(before - 60_000 - 5);
        expect(cutoff).toBeLessThanOrEqual(after - 60_000 + 5);
    });

    it("escapes single quotes in researchId so the filter can't be broken", async () => {
        const table = makeTable();
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        await searchResearchChunks({ researchId: "rid'; DROP TABLE--", vector: [0] });
        const filter = table._whereSpy.mock.calls[0]?.[0] as string;
        expect(filter).toContain("researchId = 'rid''; DROP TABLE--'");
    });

    it('omits the TTL clause when ttlMs is undefined', async () => {
        const table = makeTable();
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        await searchResearchChunks({ researchId: 'rid', vector: [0] });
        const filter = table._whereSpy.mock.calls[0]?.[0] as string;
        expect(filter).not.toContain('fetchedAt');
    });

    it('maps `_distance` to a 1/(1+d) score, sorts descending and applies k', async () => {
        const table = makeTable([
            { ...row({ id: 'far' }), _distance: 9 },
            { ...row({ id: 'mid' }), _distance: 1 },
            { ...row({ id: 'near' }), _distance: 0 },
        ]);
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        const hits = await searchResearchChunks({ researchId: 'rid', vector: [0.1], k: 2 });
        expect(hits).toHaveLength(2);
        expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
        expect(hits[0]?.score).toBeCloseTo(1, 6);
    });

    it('returns [] when the underlying search throws', async () => {
        const table = makeTable();
        table.search.mockImplementationOnce(() => ({
            where: () => ({ limit: () => ({ toArray: async () => { throw new Error('boom'); } }) }),
        }));
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        const out = await searchResearchChunks({ researchId: 'rid', vector: [0.1] });
        expect(out).toEqual([]);
    });
});

describe('researchChunks.deleteByResearchIds', () => {
    beforeEach(() => jest.clearAllMocks());

    it('is a no-op for an empty list', async () => {
        await deleteByResearchIds([]);
        expect(mockedGetTable).not.toHaveBeenCalled();
    });

    it('quotes and joins the ids in an IN clause and tolerates delete errors', async () => {
        const table = makeTable();
        table.delete.mockRejectedValueOnce(new Error('best-effort'));
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        await expect(deleteByResearchIds(["a", "b'c"])).resolves.toBeUndefined();
        expect(table.delete).toHaveBeenCalledWith("researchId IN ('a', 'b''c')");
    });

    it('is a no-op when the table does not exist', async () => {
        mockedGetTable.mockResolvedValueOnce({ table: null, justCreated: false });
        await expect(deleteByResearchIds(['a'])).resolves.toBeUndefined();
    });
});

describe('researchChunks.deleteResearchChunksOlderThan', () => {
    beforeEach(() => jest.clearAllMocks());

    it('issues a fetchedAt < cutoff predicate', async () => {
        const table = makeTable();
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        await deleteResearchChunksOlderThan(12_345);
        expect(table.delete).toHaveBeenCalledWith('fetchedAt < 12345');
    });

    it('swallows delete errors', async () => {
        const table = makeTable();
        table.delete.mockRejectedValueOnce(new Error('boom'));
        mockedGetTable.mockResolvedValueOnce({ table: table as never, justCreated: false });

        await expect(deleteResearchChunksOlderThan(1)).resolves.toBeUndefined();
    });

    it('is a no-op when the table does not exist', async () => {
        mockedGetTable.mockResolvedValueOnce({ table: null, justCreated: false });
        await expect(deleteResearchChunksOlderThan(1)).resolves.toBeUndefined();
    });
});
