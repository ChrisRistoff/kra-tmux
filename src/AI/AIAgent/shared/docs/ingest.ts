// Markdown ingest pipeline for the docs coordinator.
//
// Given a single page (markdown + metadata) coming off a worker's stdout,
// this module:
//   1. Splits the markdown via the markdown-aware chunker (heading-aware,
//      code-block atomic) so chunks carry section context.
//   2. Embeds each chunk's `contentForEmbedding` (breadcrumb + body) with
//      the existing BGE-Small encoder.
//   3. Upserts into the `doc_chunks` LanceDB table (delete-by-url-then-add)
//      so re-crawling a page replaces stale rows instead of duplicating.

import crypto from 'crypto';
import { embedMany } from '../memory/embedder';
import { getDocChunksTable } from '../memory/db';
import { chunkMarkdown } from './chunker';
import type { DocChunkRow } from './types';

export interface IngestPageInput {
    alias: string;
    url: string;
    title: string;
    markdown: string;
    indexedAt?: number;
    maxTokens?: number;
}

export interface IngestPageResult {
    chunksWritten: number;
    chunksSkipped: number;
    chunksDeleted: number;
    pageHash: string;
}

interface BuiltDocChunk {
    row: Omit<DocChunkRow, 'vector'>;
    contentForEmbedding: string;
}

export function buildDocChunks(input: IngestPageInput): BuiltDocChunk[] {
    const indexedAt = input.indexedAt ?? Date.now();
    const opts: { pageTitle?: string; maxTokens?: number } = {};
    if (input.title) opts.pageTitle = input.title;
    if (input.maxTokens !== undefined) opts.maxTokens = input.maxTokens;

    const chunks = chunkMarkdown(input.markdown, opts);
    const out: BuiltDocChunk[] = [];

    chunks.forEach((chunk, chunkIndex) => {
        const slice = chunk.content;
        if (slice.trim().length === 0) return;

        const hash = crypto.createHash('sha1')
            .update(input.alias)
            .update('\u0000')
            .update(input.url)
            .update('\u0000')
            .update(chunk.sectionPath)
            .update('\u0000')
            .update(String(chunkIndex))
            .update('\u0000')
            .update(slice)
            .digest('hex');

        const id = `${input.alias}:${hashShort(input.url)}:${chunkIndex}:${hash.slice(0, 12)}`;

        out.push({
            row: {
                id,
                sourceAlias: input.alias,
                url: input.url,
                pageTitle: input.title,
                sectionPath: chunk.sectionPath,
                chunkIndex,
                tokenCount: chunk.tokenCount,
                content: slice,
                contentHash: hash,
                indexedAt,
            },
            contentForEmbedding: chunk.contentForEmbedding,
        });
    });

    return out;
}

export function pageHash(markdown: string): string {
    return crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex');
}

/**
 * Chunk + embed + upsert a single page. Existing rows for the same `url` are
 * deleted before the new rows are inserted so a re-crawl of the same page
 * replaces stale chunks.
 */
export async function ingestPage(input: IngestPageInput): Promise<IngestPageResult> {
    const built = buildDocChunks(input);

    const ph = pageHash(input.markdown);

    if (built.length === 0) {
        await removePage(input.alias, input.url);

        return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: 0, pageHash: ph };
    }

    const vectors = await embedMany(built.map((b) => b.contentForEmbedding));
    const rows: DocChunkRow[] = built.map((b, i) => ({ ...b.row, vector: vectors[i] }));

    const seedRow = rows[0] ?? null;
    const { table, justCreated } = await getDocChunksTable(seedRow);

    if (!table) {
        return { chunksWritten: 0, chunksSkipped: 0, chunksDeleted: 0, pageHash: ph };
    }

    let chunksDeleted = 0;
    if (!justCreated) {
        chunksDeleted = await deleteByUrl(input.alias, input.url);
    }

    let written = 0;
    if (rows.length > 0) {
        if (justCreated) {
            if (rows.length > 1) {
                await table.add(rows.slice(1) as unknown as Record<string, unknown>[]);
            }
        } else {
            await table.add(rows as unknown as Record<string, unknown>[]);
        }
        written = rows.length;
    }

    return { chunksWritten: written, chunksSkipped: 0, chunksDeleted, pageHash: ph };
}

/**
 * Remove every chunk for a single page. Returns the number deleted.
 */
export async function removePage(alias: string, url: string): Promise<number> {
    return deleteByUrl(alias, url);
}

/**
 * Remove every chunk for a whole source. Used when a source is dropped from
 * settings or when the user explicitly purges via `kra ai docs ...` (future).
 */
export async function removeSource(alias: string): Promise<number> {
    const { table } = await getDocChunksTable(null);
    if (!table) return 0;

    const before = await safeCount(table);
    await table.delete(`sourceAlias = '${escapeSql(alias)}'`);
    const after = await safeCount(table);

    return Math.max(0, before - after);
}

async function deleteByUrl(alias: string, url: string): Promise<number> {
    const { table } = await getDocChunksTable(null);
    if (!table) return 0;

    const before = await safeCount(table);
    await table.delete(
        `sourceAlias = '${escapeSql(alias)}' AND url = '${escapeSql(url)}'`,
    );
    const after = await safeCount(table);

    return Math.max(0, before - after);
}

async function safeCount(table: { countRows: () => Promise<number> }): Promise<number> {
    try {
        return await table.countRows();
    } catch {
        return 0;
    }
}

function escapeSql(s: string): string {
    return s.replace(/'/g, "''");
}

function hashShort(s: string): string {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}
