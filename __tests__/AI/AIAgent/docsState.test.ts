import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    docsStateFilePath,
    loadDocsState,
    saveDocsState,
    getPageState,
    setPageState,
    knownPagesForAlias,
    dropAliasState,
    applyPageFetched,
    applyPageUnchanged,
    applyPageSkipped,
} from '@/AI/AIAgent/shared/docs/state';
import type { DocsStateFile } from '@/AI/AIAgent/shared/docs/types';

let tmpRoot: string;
let prevWorkingDir: string | undefined;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kra-docs-state-'));
    prevWorkingDir = process.env['WORKING_DIR'];
    process.env['WORKING_DIR'] = tmpRoot;
});

afterEach(() => {
    if (prevWorkingDir === undefined) {
        delete process.env['WORKING_DIR'];
    } else {
        process.env['WORKING_DIR'] = prevWorkingDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function freshState(): DocsStateFile {
    return { version: 1, pages: {} };
}

describe('docs state I/O', () => {
    it('loadDocsState returns empty when file is missing', () => {
        const state = loadDocsState();
        expect(state).toEqual({ version: 1, pages: {} });
        expect(fs.existsSync(docsStateFilePath())).toBe(false);
    });

    it('round-trips through save/load', () => {
        const state = freshState();
        setPageState(state, 'aws', 'https://aws/foo', {
            etag: 'W/"abc"',
            lastModified: 'Wed, 21 Oct 2024 07:28:00 GMT',
            pageHash: 'hash-foo',
            chunkCount: 3,
            lastIndexedAt: 1700000000000,
        });
        saveDocsState(state);

        expect(fs.existsSync(docsStateFilePath())).toBe(true);
        const reloaded = loadDocsState();
        expect(reloaded.version).toBe(1);
        expect(getPageState(reloaded, 'aws', 'https://aws/foo')).toEqual({
            etag: 'W/"abc"',
            lastModified: 'Wed, 21 Oct 2024 07:28:00 GMT',
            pageHash: 'hash-foo',
            chunkCount: 3,
            lastIndexedAt: 1700000000000,
        });
    });

    it('loadDocsState resets when version mismatches', () => {
        fs.mkdirSync(path.dirname(docsStateFilePath()), { recursive: true });
        fs.writeFileSync(
            docsStateFilePath(),
            JSON.stringify({ version: 99, pages: { 'x|y': { pageHash: 'h', chunkCount: 1, lastIndexedAt: 0 } } }),
        );
        const state = loadDocsState();
        expect(state.pages).toEqual({});
    });

    it('loadDocsState recovers gracefully from corrupt JSON', () => {
        fs.mkdirSync(path.dirname(docsStateFilePath()), { recursive: true });
        fs.writeFileSync(docsStateFilePath(), '{not json');
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const state = loadDocsState();
        expect(state).toEqual({ version: 1, pages: {} });
        errSpy.mockRestore();
    });
});

describe('alias-scoped helpers', () => {
    it('knownPagesForAlias filters by alias prefix and strips it', () => {
        const state = freshState();
        setPageState(state, 'aws', 'https://aws/a', { pageHash: 'a', chunkCount: 1, lastIndexedAt: 1 });
        setPageState(state, 'aws', 'https://aws/b', { pageHash: 'b', chunkCount: 2, lastIndexedAt: 2 });
        setPageState(state, 'gcp', 'https://gcp/x', { pageHash: 'x', chunkCount: 3, lastIndexedAt: 3 });

        const aws = knownPagesForAlias(state, 'aws');
        expect(Object.keys(aws).sort()).toEqual(['https://aws/a', 'https://aws/b']);
        expect(aws['https://aws/a']?.pageHash).toBe('a');
        expect(aws['https://gcp/x']).toBeUndefined();
    });

    it('dropAliasState removes only the matching alias', () => {
        const state = freshState();
        setPageState(state, 'aws', 'https://aws/a', { pageHash: 'a', chunkCount: 1, lastIndexedAt: 1 });
        setPageState(state, 'gcp', 'https://gcp/x', { pageHash: 'x', chunkCount: 1, lastIndexedAt: 1 });

        dropAliasState(state, 'aws');
        expect(knownPagesForAlias(state, 'aws')).toEqual({});
        expect(Object.keys(knownPagesForAlias(state, 'gcp'))).toEqual(['https://gcp/x']);
    });
});

describe('coordinator IPC state mutators', () => {
    it('applyPageFetched stores fresh hash + headers', () => {
        const state = freshState();
        applyPageFetched(state, 'aws', 'https://aws/p', {
            pageHash: 'h1',
            chunkCount: 5,
            indexedAt: 1234,
            etag: 'W/"v1"',
            lastModified: 'Sun, 01 Jan 2024 00:00:00 GMT',
        });
        expect(getPageState(state, 'aws', 'https://aws/p')).toEqual({
            lastIndexedAt: 1234,
            pageHash: 'h1',
            chunkCount: 5,
            etag: 'W/"v1"',
            lastModified: 'Sun, 01 Jan 2024 00:00:00 GMT',
        });
    });

    it('applyPageFetched omits etag/lastModified when not provided', () => {
        const state = freshState();
        applyPageFetched(state, 'aws', 'https://aws/p', {
            pageHash: 'h1',
            chunkCount: 2,
            indexedAt: 1,
        });
        const ps = getPageState(state, 'aws', 'https://aws/p');
        expect(ps).toBeDefined();
        expect(ps).not.toHaveProperty('etag');
        expect(ps).not.toHaveProperty('lastModified');
    });

    it('applyPageUnchanged preserves prior chunkCount and refreshes lastIndexedAt', () => {
        const state = freshState();
        applyPageFetched(state, 'aws', 'https://aws/p', {
            pageHash: 'h1',
            chunkCount: 7,
            indexedAt: 100,
        });
        applyPageUnchanged(state, 'aws', 'https://aws/p', {
            pageHash: 'h1',
            indexedAt: 999,
            etag: 'W/"v2"',
        });
        const ps = getPageState(state, 'aws', 'https://aws/p');
        expect(ps?.chunkCount).toBe(7);
        expect(ps?.lastIndexedAt).toBe(999);
        expect(ps?.etag).toBe('W/"v2"');
    });

    it('applyPageUnchanged for a previously-unknown URL defaults chunkCount to 0', () => {
        const state = freshState();
        applyPageUnchanged(state, 'aws', 'https://aws/new', {
            pageHash: 'h-new',
            indexedAt: 5,
        });
        expect(getPageState(state, 'aws', 'https://aws/new')).toEqual({
            lastIndexedAt: 5,
            pageHash: 'h-new',
            chunkCount: 0,
        });
    });

    it('applyPageSkipped only refreshes lastIndexedAt when the page is known', () => {
        const state = freshState();
        applyPageFetched(state, 'aws', 'https://aws/p', {
            pageHash: 'h1',
            chunkCount: 3,
            indexedAt: 100,
        });

        applyPageSkipped(state, 'aws', 'https://aws/p', 555);
        expect(getPageState(state, 'aws', 'https://aws/p')?.lastIndexedAt).toBe(555);
        expect(getPageState(state, 'aws', 'https://aws/p')?.pageHash).toBe('h1');

        applyPageSkipped(state, 'aws', 'https://aws/never-seen', 999);
        expect(getPageState(state, 'aws', 'https://aws/never-seen')).toBeUndefined();
    });
});
