import * as fs from 'fs/promises';
import * as path from 'path';
import type * as neovim from 'neovim';
import { execCommand } from '@/utils/bashHelper';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 8 * 1024;   // 8 KB

export interface BashSnapshot {
    /** git status snapshots keyed by repo cwd. */
    statusByCwd: Map<string, Map<string, string>>;
}

interface MutationEntry {
    path: string;
    beforeContent: string | null;
    afterContent: string | null;
    source: string;
}

export interface AgentHistory {
    recordMutation: (opts: {
        path: string;
        beforeContent: string | null;
        afterContent: string | null;
        source: string;
    }) => void;
    /** Returns the first-ever recorded `beforeContent` for this path (pre-session state).
     *  Returns `undefined` if the path has never been recorded. */
    getOriginalContent: (filePath: string) => string | null | undefined;
    /** Reverts every path in history back to its pre-session state. */
    revertAll: (nvim: neovim.NeovimClient) => Promise<void>;
    /** All absolute paths that have at least one recorded mutation. */
    listChangedPaths: () => string[];
    /** Snapshot git-tracked change state before a bash command runs. */
    bashSnapshotBefore: () => Promise<BashSnapshot>;
    /** Compare against prior snapshot and record any new mutations. */
    bashSnapshotAfter: (before: BashSnapshot) => Promise<void>;
}

function quoteForShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isBinaryBuffer(buf: Buffer): boolean {
    const limit = Math.min(buf.length, BINARY_CHECK_BYTES);
    for (let i = 0; i < limit; i++) {
        if (buf[i] === 0) return true;
    }

    return false;
}

async function gitStatus(cwd: string): Promise<Map<string, string>> {
    try {
        const result = await execCommand(
            `git -C ${quoteForShell(cwd)} status --porcelain=v1 -uall -z`
        );
        const map = new Map<string, string>();
        const raw = result.stdout;
        let i = 0;
        while (i < raw.length) {
            // Each entry: "XY filename\0"  (3-char prefix + NUL-terminated path).
            // Renames produce two NUL-terminated tokens; skip the second.
            if (i + 3 > raw.length) break;
            const status = raw.slice(i, i + 2).trim();
            i += 3; // skip "XY "
            const end = raw.indexOf('\0', i);
            if (end === -1) break;
            const filePath = raw.slice(i, end);
            map.set(filePath, status);
            i = end + 1;
            if (status === 'R' || status === 'C') {
                // Rename/copy: skip the old name
                const end2 = raw.indexOf('\0', i);
                if (end2 !== -1) i = end2 + 1;
            }
        }

        return map;
    } catch {
        return new Map();
    }
}

export function createAgentHistory(cwds: string[]): AgentHistory {
    if (cwds.length === 0) {
        throw new Error('createAgentHistory: at least one cwd required');
    }
    const trackedCwds: string[] = [...new Set(cwds)];
    // First-seen "before" per absolute path — the pre-session original.
    const originalContent = new Map<string, string | null>();
    const entries: MutationEntry[] = [];

    function recordMutation(opts: {
        path: string;
        beforeContent: string | null;
        afterContent: string | null;
        source: string;
    }): void {
        if (!originalContent.has(opts.path)) {
            originalContent.set(opts.path, opts.beforeContent);
        }
        entries.push(opts);
    }

    function getOriginalContent(filePath: string): string | null | undefined {
        if (!originalContent.has(filePath)) return undefined;

        return originalContent.get(filePath) ?? null;
    }

    async function revertAll(nvim: neovim.NeovimClient): Promise<void> {
        const paths = new Set(entries.map(e => e.path));
        let reverted = 0;
        let failed = 0;

        for (const filePath of paths) {
            try {
                const original = originalContent.get(filePath);
                if (original === undefined) continue;

                if (original === null) {
                    // File didn't exist originally → delete it.
                    await fs.rm(filePath, { force: true });
                } else {
                    // File existed → restore its original content.
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, original, 'utf8');
                }
                reverted++;
            } catch {
                failed++;
            }
        }

        const msg = failed > 0
            ? `Reverted ${reverted} file(s); ${failed} failed.`
            : `Reverted ${reverted} file(s).`;

        try {
            await nvim.command(`echo '${msg.replace(/'/g, `'\\''`)}'`);
        } catch { /* nvim may be disconnecting */ }
    }

    function listChangedPaths(): string[] {
        return [...new Set(entries.map(e => e.path))];
    }

    async function bashSnapshotBefore(): Promise<BashSnapshot> {
        const statusByCwd = new Map<string, Map<string, string>>();
        await Promise.all(trackedCwds.map(async (c) => {
            statusByCwd.set(c, await gitStatus(c));
        }));

        return { statusByCwd };
    }

    async function bashSnapshotAfter(before: BashSnapshot): Promise<void> {
        for (const c of trackedCwds) {
            const beforeStatus = before.statusByCwd.get(c) ?? new Map<string, string>();
            const after = await gitStatus(c);
            const changedRelPaths = new Set<string>();

            for (const [p, status] of after) {
                if (!beforeStatus.has(p) || beforeStatus.get(p) !== status) {
                    changedRelPaths.add(p);
                }
            }
            // Paths that were dirty before but are now clean (e.g. reverted by bash).
            for (const [p] of beforeStatus) {
                if (!after.has(p)) changedRelPaths.add(p);
            }

            for (const relPath of changedRelPaths) {
                const absPath = path.join(c, relPath);

                // Determine beforeContent (pre-bash state).
                let beforeContent: string | null;
                if (originalContent.has(absPath)) {
                    // Already tracked — original is already correct in the map; pass it
                    // again so the entry is still meaningful but won't overwrite the map.
                    beforeContent = originalContent.get(absPath) ?? null;
                } else {
                    try {
                        const result = await execCommand(
                            `git -C ${quoteForShell(c)} show HEAD:${quoteForShell(relPath)}`
                        );
                        beforeContent = result.stdout;
                    } catch {
                        beforeContent = null; // new untracked file
                    }
                }

                // Determine afterContent (post-bash state on disk).
                let afterContent: string | null;
                try {
                    const stat = await fs.stat(absPath);
                    if (stat.size > MAX_FILE_SIZE) continue; // skip very large files
                    const raw = await fs.readFile(absPath);
                    afterContent = isBinaryBuffer(raw) ? null : raw.toString('utf8');
                } catch {
                    afterContent = null; // file was deleted
                }

                recordMutation({ path: absPath, beforeContent, afterContent, source: 'bash' });
            }
        }
    }

    return {
        recordMutation,
        getOriginalContent,
        revertAll,
        listChangedPaths,
        bashSnapshotBefore,
        bashSnapshotAfter,
    };
}
