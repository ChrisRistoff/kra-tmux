/**
 * Compute which files have changed since the last code-index pass so the
 * agent can catch up without doing a full reindex on every launch.
 *
 * Strategy by repo type:
 *   - **Git repo with a known `lastIndexedCommit`**: union of
 *       `git diff --name-only $lastIndexedCommit HEAD` (committed changes
 *           since the index)
 *       `git status --porcelain` (modified, staged, and untracked uncommitted
 *           changes — including files the user edited externally before
 *           launching the agent).
 *     Deletions are reported with `kind: 'delete'`; everything else is
 *     `kind: 'index'`.
 *   - **Git repo without a `lastIndexedCommit`**: treat as first-time
 *       index — caller should run `reindexAll` instead.
 *   - **Non-git workspace**: walk the indexable file list (using the same
 *       filter as the indexer) and compare each file's mtime to
 *       `lastIndexedAt`.
 *
 * If the resulting change set exceeds `CATCHUP_FULL_REINDEX_THRESHOLD`, the
 * caller should prompt the user and prefer `reindexAll` for speed.
 */

import * as fs from 'fs/promises';
import path from 'path';
import { execCommand } from '@/utils/bashHelper';
import { isIndexable, listIndexableFiles, workspaceRoot } from './indexer';
import { loadMemorySettings } from './settings';

export const CATCHUP_FULL_REINDEX_THRESHOLD = 500;

export interface CatchupChange {
    relPath: string;
    kind: 'index' | 'delete';
}

export interface CatchupPlan {
    changes: CatchupChange[];
    /**
     * `true` when the change set is so large that a full reindex would
     * almost certainly be faster than walking the catch-up list.
     */
    exceedsThreshold: boolean;
    /** Source of the diff so the UI can label it. */
    source: 'git' | 'mtime' | 'first-time';
    /** Current HEAD SHA to persist after the catch-up applies (git only). */
    headCommit: string | null;
}

function quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function tryExec(cmd: string): Promise<string | null> {
    try {
        const result = await execCommand(cmd);

        return result.stdout;
    } catch {
        return null;
    }
}

async function getHeadCommit(repoRoot: string): Promise<string | null> {
    const head = await tryExec(`git -C ${quote(repoRoot)} rev-parse HEAD`);

    return head ? head.trim() || null : null;
}

async function isGitRepo(repoRoot: string): Promise<boolean> {
    const inside = await tryExec(`git -C ${quote(repoRoot)} rev-parse --is-inside-work-tree`);

    return inside !== null && inside.trim() === 'true';
}

/**
 * Parse `git diff --name-status` output into our change shape. The format is
 * `<status>\t<path>` (or `<status>\t<old>\t<new>` for renames).
 */
function parseNameStatus(stdout: string): CatchupChange[] {
    const changes: CatchupChange[] = [];

    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trimEnd();

        if (!line) continue;
        const parts = line.split('\t');
        const status = parts[0]?.charAt(0) ?? '';

        if (status === 'D') {
            const p = parts[1];

            if (p) changes.push({ relPath: p, kind: 'delete' });
            continue;
        }

        if (status === 'R' || status === 'C') {
            const oldPath = parts[1];
            const newPath = parts[2];

            if (oldPath) changes.push({ relPath: oldPath, kind: 'delete' });
            if (newPath) changes.push({ relPath: newPath, kind: 'index' });
            continue;
        }

        const p = parts[1];

        if (p) changes.push({ relPath: p, kind: 'index' });
    }

    return changes;
}

/** Parse `git status --porcelain` (short form) into our change shape. */
function parsePorcelain(stdout: string): CatchupChange[] {
    const changes: CatchupChange[] = [];

    for (const rawLine of stdout.split('\n')) {
        if (!rawLine) continue;
        // Lines look like ` M path`, `?? path`, `D  path`, `R  old -> new`, etc.
        const xy = rawLine.slice(0, 2);
        const rest = rawLine.slice(3);
        const isDelete = xy.includes('D');

        if (xy.startsWith('R') || xy.startsWith('C')) {
            const arrow = rest.indexOf(' -> ');

            if (arrow >= 0) {
                const oldPath = rest.slice(0, arrow).trim();
                const newPath = rest.slice(arrow + 4).trim();

                if (oldPath) changes.push({ relPath: oldPath, kind: 'delete' });
                if (newPath) changes.push({ relPath: newPath, kind: 'index' });
                continue;
            }
        }

        const p = rest.trim();
        if (!p) continue;
        changes.push({ relPath: p, kind: isDelete ? 'delete' : 'index' });
    }

    return changes;
}

function mergeChanges(...lists: CatchupChange[][]): CatchupChange[] {
    const seen = new Map<string, CatchupChange>();

    for (const list of lists) {
        for (const change of list) {
            // Later lists override earlier (uncommitted overrides committed).
            seen.set(change.relPath, change);
        }
    }

    return [...seen.values()];
}

/**
 * Build the list of files that need to be (re)indexed for the current
 * workspace, given the previously persisted `lastIndexedCommit` /
 * `lastIndexedAt` from the registry.
 */
async function filterDirtyByMtime(
    changes: CatchupChange[],
    repoRoot: string,
    lastIndexedAt: number,
): Promise<CatchupChange[]> {
    const results = await Promise.all(
        changes.map(async (c): Promise<CatchupChange | null> => {
            if (c.kind === 'delete') return c;

            try {
                const stat = await fs.stat(path.join(repoRoot, c.relPath));

                return stat.mtimeMs > lastIndexedAt ? c : null;
            } catch {
                // File unreadable — treat as deleted.
                return { relPath: c.relPath, kind: 'delete' };
            }
        }),
    );

    return results.filter((c): c is CatchupChange => c !== null);
}


export async function computeChangedFiles(opts: {
    repoRoot?: string;
    lastIndexedCommit: string;
    lastIndexedAt: number;
}): Promise<CatchupPlan> {
    const repoRoot = opts.repoRoot ?? workspaceRoot();

    if (await isGitRepo(repoRoot)) {
        const headCommit = await getHeadCommit(repoRoot);

        if (!opts.lastIndexedCommit) {
            return {
                changes: [],
                exceedsThreshold: false,
                source: 'first-time',
                headCommit,
            };
        }

        const settings = await loadMemorySettings();
        const committedRaw = await tryExec(
            `git -C ${quote(repoRoot)} diff --name-status ${quote(opts.lastIndexedCommit)} HEAD`,
        );
        const dirtyRaw = await tryExec(`git -C ${quote(repoRoot)} status --porcelain`);
        const committed = committedRaw ? parseNameStatus(committedRaw) : [];
        const allDirty = dirtyRaw ? parsePorcelain(dirtyRaw) : [];

        // Filter dirty (uncommitted) files by mtime so that files already indexed
        // in the last session don't re-appear on every startup. Committed changes
        // are always included because their content is definitively newer.
        const dirty = opts.lastIndexedAt
            ? await filterDirtyByMtime(allDirty, repoRoot, opts.lastIndexedAt)
            : allDirty;

        const merged = mergeChanges(committed, dirty)
            .filter((c) => c.kind === 'delete' || isIndexable(c.relPath, settings));

        return {
            changes: merged,
            exceedsThreshold: merged.length > CATCHUP_FULL_REINDEX_THRESHOLD,
            source: 'git',
            headCommit,
        };
    }

    // Non-git fallback: mtime > lastIndexedAt across the indexable set.
    if (!opts.lastIndexedAt) {
        return { changes: [], exceedsThreshold: false, source: 'first-time', headCommit: null };
    }

    const settings = await loadMemorySettings();
    const files = await listIndexableFiles(repoRoot, settings);
    const changes: CatchupChange[] = [];

    for (const rel of files) {
        const abs = path.join(repoRoot, rel);

        try {
            const stat = await fs.stat(abs);

            if (stat.mtimeMs > opts.lastIndexedAt) {
                changes.push({ relPath: rel, kind: 'index' });
            }
        } catch {
            changes.push({ relPath: rel, kind: 'delete' });
        }
    }

    return {
        changes,
        exceedsThreshold: changes.length > CATCHUP_FULL_REINDEX_THRESHOLD,
        source: 'mtime',
        headCommit: null,
    };
}
