/**
 * Fixed-line-window chunker for the code-indexing pipeline.
 *
 * Why fixed windows instead of outline-aware boundaries?
 *   - Outline detection requires LSP startup per language; doing that across
 *     thousands of files at index time is too slow and brings up 8 servers.
 *   - Fixed windows are deterministic, language-agnostic, and produce
 *     stable IDs that play well with content-hash dedup.
 *   - Embedding quality on BGE-small for 80-line windows is plenty for the
 *     "where does X happen" query the user actually issues.
 *
 * Each chunk is a contiguous slice `[startLine, endLine]` (1-indexed,
 * inclusive). Chunks overlap by `overlap` lines so a symbol that spans a
 * chunk boundary still gets retrievable context.
 */

import path from 'path';
import crypto from 'crypto';
import type { CodeChunkRow } from './types';

export interface ChunkBuildInput {
    relPath: string;
    content: string;
    chunkLines: number;
    chunkOverlap: number;
    indexedAt: number;
}

export interface BuiltChunk {
    row: Omit<CodeChunkRow, 'vector'>;
}

export function buildChunks(input: ChunkBuildInput): BuiltChunk[] {
    const lines = input.content.split('\n');
    const total = lines.length;

    if (total === 0 || (total === 1 && lines[0] === '')) return [];

    const step = Math.max(1, input.chunkLines - input.chunkOverlap);
    const chunks: BuiltChunk[] = [];
    const language = languageFromPath(input.relPath);

    for (let start = 0; start < total; start += step) {
        const end = Math.min(start + input.chunkLines, total);
        const slice = lines.slice(start, end).join('\n');

        if (slice.trim() === '') continue;

        const startLine = start + 1;
        const endLine = end;
        const hash = crypto.createHash('sha1')
            .update(input.relPath)
            .update('\0')
            .update(String(startLine))
            .update('\0')
            .update(slice)
            .digest('hex');
        const id = `${input.relPath}:${startLine}-${endLine}:${hash.slice(0, 12)}`;

        chunks.push({
            row: {
                id,
                path: input.relPath,
                startLine,
                endLine,
                symbol: '',
                language,
                content: slice,
                contentHash: hash,
                indexedAt: input.indexedAt,
            },
        });

        if (end >= total) break;
    }

    return chunks;
}

const LANG_BY_EXT: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.c': 'c', '.h': 'c',
    '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.lua': 'lua',
    '.md': 'markdown',
    '.toml': 'toml',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.json': 'json', '.jsonc': 'json',
};

function languageFromPath(p: string): string {
    return LANG_BY_EXT[path.extname(p).toLowerCase()] ?? 'plaintext';
}
