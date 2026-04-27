import { recall } from '@/AI/AIAgent/shared/memory/notes';
import { semanticSearch } from '@/AI/AIAgent/shared/memory/search';
import { getCodeChunksTable, getFindingsTable, getRevisitsTable } from '@/AI/AIAgent/shared/memory/db';
import { embedOne } from '@/AI/AIAgent/shared/memory/embedder';
import type { MemoryKind, MemoryRow } from '@/AI/AIAgent/shared/memory/types';

jest.mock('@/AI/AIAgent/shared/memory/embedder', () => ({
    embedOne: jest.fn(async () => [0.1, 0.2, 0.3]),
}));

jest.mock('@/AI/AIAgent/shared/memory/db', () => ({
    getCodeChunksTable: jest.fn(),
    getFindingsTable: jest.fn(),
    getRevisitsTable: jest.fn(),
}));

jest.mock('@/AI/AIAgent/shared/memory/indexer', () => ({
    matchGlob: jest.fn(() => true),
}));

const mockedEmbedOne = jest.mocked(embedOne);
const mockedGetCodeChunksTable = jest.mocked(getCodeChunksTable);
const mockedGetFindingsTable = jest.mocked(getFindingsTable);
const mockedGetRevisitsTable = jest.mocked(getRevisitsTable);

function makeMemoryRow(id: string, kind: MemoryKind, createdAt: number): MemoryRow {
    return {
        id,
        kind,
        title: `${kind} ${id}`,
        body: `body for ${id}`,
        tags: JSON.stringify(['memory']),
        paths: JSON.stringify(['src/example.ts']),
        branch: '',
        status: kind === 'revisit' ? 'open' : 'resolved',
        resolution: '',
        createdAt,
        updatedAt: createdAt,
        source: 'agent-auto',
        vector: [0.1, 0.2, 0.3],
    };
}

function makeTable(queryRows: unknown[], searchRows: unknown[] = queryRows): { countRows: jest.Mock; query: jest.Mock; search: jest.Mock } {
    return {
        countRows: jest.fn(async () => queryRows.length),
        query: jest.fn(() => ({
            limit: jest.fn(() => ({
                toArray: jest.fn(async () => queryRows),
            })),
        })),
        search: jest.fn(() => ({
            limit: jest.fn(() => ({
                toArray: jest.fn(async () => searchRows),
            })),
        })),
    };
}

describe('memory lookup filters', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedGetCodeChunksTable.mockResolvedValue({ table: null, justCreated: false });
        mockedGetRevisitsTable.mockResolvedValue({ table: null, justCreated: false });
    });

    it('recall supports findings as a combined lookup kind', async () => {
        const older = makeMemoryRow('note-1', 'note', 100);
        const newer = makeMemoryRow('investigation-1', 'investigation', 200);
        mockedGetFindingsTable.mockResolvedValue({
            table: makeTable([older, newer]) as never,
            justCreated: false,
        });

        const result = await recall({ kind: 'findings' });

        expect(result.map((entry) => entry.id)).toEqual(['investigation-1', 'note-1']);
    });

    it('recall limits findings results to the selected ids', async () => {
        const note = makeMemoryRow('note-1', 'note', 100);
        const gotcha = makeMemoryRow('gotcha-1', 'gotcha', 200);
        mockedGetFindingsTable.mockResolvedValue({
            table: makeTable([note, gotcha]) as never,
            justCreated: false,
        });

        const result = await recall({ kind: 'findings', selectedIds: ['note-1'] });

        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe('note-1');
    });

    it('semanticSearch supports findings memory searches and selected ids', async () => {
        const noteHit = { ...makeMemoryRow('note-1', 'note', 100), _distance: 0.05 };
        const decisionHit = { ...makeMemoryRow('decision-1', 'decision', 200), _distance: 0.02 };
        mockedGetFindingsTable.mockResolvedValue({
            table: makeTable([], [noteHit, decisionHit]) as never,
            justCreated: false,
        });

        const result = await semanticSearch({
            query: 'release decision',
            scope: 'memory',
            memoryKind: 'findings',
            selectedIds: ['note-1'],
        });

        expect(mockedEmbedOne).toHaveBeenCalledWith('release decision');
        expect(result).toHaveLength(1);
        expect(result[0]?.type).toBe('memory');
        expect(result[0]?.memory?.id).toBe('note-1');
    });
});
