/**
 * Shared file-safety utilities used by the file-context MCP server and the
 * agent tool-hook layer. Centralises:
 *   - atomic writes (temp file in same dir + rename)
 *   - binary-file detection (refuse to dump non-text into the agent context)
 *   - per-call line caps for read_lines
 *   - unified-diff patch parsing and application
 */

import * as fs from 'fs/promises';
import path from 'path';

// Cap how many lines a single read_lines call may return. A buggy `end: 999999`
// would otherwise dump the entire file and defeat the whole point of the
// outline-based workflow.
export const MAX_LINES_PER_CALL = 500;

// First-N-bytes binary heuristic. A NUL byte in the first 8 KiB is a strong
// signal that the file is not utf-8 source code.
const BINARY_PROBE_BYTES = 8000;

export function looksBinary(buf: Buffer): boolean {
    const limit = Math.min(buf.length, BINARY_PROBE_BYTES);

    for (let i = 0; i < limit; i++) {
        if (buf[i] === 0) return true;
    }

    return false;
}

export async function isBinaryFile(filePath: string): Promise<boolean> {
    const fh = await fs.open(filePath, 'r');

    try {
        const buf = Buffer.alloc(BINARY_PROBE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, BINARY_PROBE_BYTES, 0);

        return looksBinary(buf.subarray(0, bytesRead));
    } finally {
        await fh.close();
    }
}

// Atomic write: stage to a sibling temp file, then rename. fs.rename is atomic
// on POSIX within the same filesystem, so a crash mid-write never leaves a
// half-written destination.
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const base = path.basename(filePath);
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tmp = path.join(dir, `.${base}.kra-tmp-${suffix}`);

    try {
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, filePath);
    } catch (err) {
        try { await fs.unlink(tmp); } catch { /* tmp may not exist */ }
        throw err;
    }
}

