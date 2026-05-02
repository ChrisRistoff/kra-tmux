/**
 * Persistence helpers for incremental docs re-crawl state.
 *
 * Stores per-page metadata (etag, last-modified, content hash, last-indexed
 * timestamp) so the worker can skip pages whose content hasn't changed since
 * the last successful crawl.
 *
 * Lives at `~/.kra/.kra-memory/docs/docs-state.json` (global — docs are
 * shared across repos). Owned exclusively by the coordinator process —
 * workers receive their slice of `knownPages` over stdin and never touch
 */

import fs from 'fs/promises';
import { kraDocsRoot, kraDocsStatePath } from '@/filePaths';
import type { DocsStateFile, DocsPageState } from './types';
import { pageStateKey } from './types';

const STATE_VERSION = 1;

export function docsStateFilePath(): string {
    return kraDocsStatePath;
}

export async function loadDocsState(): Promise<DocsStateFile> {
    const fp = docsStateFilePath();
    try {
        const raw = await fs.readFile(fp, 'utf-8');
        const parsed = JSON.parse(raw) as DocsStateFile;
        if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION || !parsed.pages) {
            return { version: STATE_VERSION, pages: {} };
        }

        return parsed;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: STATE_VERSION, pages: {} };
        }
        console.error('docs-state: failed to load, starting fresh:', err);

        return { version: STATE_VERSION, pages: {} };
    }
}

export async function saveDocsState(state: DocsStateFile): Promise<void> {
    try {
        await fs.mkdir(kraDocsRoot, { recursive: true });
        await fs.writeFile(docsStateFilePath(), JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('docs-state: failed to save:', err);
    }
}

export function getPageState(state: DocsStateFile, alias: string, url: string): DocsPageState | undefined {
    return state.pages[pageStateKey(alias, url)];
}

export function setPageState(state: DocsStateFile, alias: string, url: string, page: DocsPageState): void {
    state.pages[pageStateKey(alias, url)] = page;
}

export function knownPagesForAlias(state: DocsStateFile, alias: string): Record<string, DocsPageState> {
    const prefix = `${alias}|`;
    const out: Record<string, DocsPageState> = {};
    for (const [k, v] of Object.entries(state.pages)) {
        if (k.startsWith(prefix)) {
            out[k.slice(prefix.length)] = v;
        }
    }

    return out;
}

export function dropAliasState(state: DocsStateFile, alias: string): void {
    const prefix = `${alias}|`;
    for (const k of Object.keys(state.pages)) {
        if (k.startsWith(prefix)) {
            delete state.pages[k];
        }
    }
}

/**
 * Pure state mutators used by the coordinator's IPC handler. Kept here
 * so they can be unit-tested in isolation without spinning up the long-lived
 * coordinator process.
 */
export function applyPageFetched(
    state: DocsStateFile,
    alias: string,
    url: string,
    args: { pageHash: string; chunkCount: number; etag?: string; lastModified?: string; indexedAt: number },
): void {
    const ps: DocsPageState = {
        lastIndexedAt: args.indexedAt,
        pageHash: args.pageHash,
        chunkCount: args.chunkCount,
    };
    if (args.etag) ps.etag = args.etag;
    if (args.lastModified) ps.lastModified = args.lastModified;
    setPageState(state, alias, url, ps);
}

export function applyPageUnchanged(
    state: DocsStateFile,
    alias: string,
    url: string,
    args: { pageHash: string; etag?: string; lastModified?: string; indexedAt: number },
): void {
    const existing = getPageState(state, alias, url);
    const ps: DocsPageState = {
        lastIndexedAt: args.indexedAt,
        pageHash: args.pageHash,
        chunkCount: existing?.chunkCount ?? 0,
    };
    if (args.etag) ps.etag = args.etag;
    if (args.lastModified) ps.lastModified = args.lastModified;
    setPageState(state, alias, url, ps);
}

export function applyPageSkipped(
    state: DocsStateFile,
    alias: string,
    url: string,
    indexedAt: number,
): void {
    const existing = getPageState(state, alias, url);
    if (existing) {
        existing.lastIndexedAt = indexedAt;
    }
}
