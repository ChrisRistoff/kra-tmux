import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execCommand } from '@/utils/bashHelper';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 8 * 1024;   // 8 KB

// ---- Disk-backed original-content cache ---------------------------------
// Original (pre-edit) file content is hashed and spilled to a per-process
// temp dir. The in-memory map only retains the SHA (or `null` when the file
// did not exist pre-edit). This keeps `originalContent` from holding tens of
// megabytes of file bytes for the lifetime of an agent session.
//
// Layout: $TMPDIR/kra-agent-state-ts-<pid>/originals/<sha>.bin
// Cleanup: best-effort on graceful exit (see registerExitCleanup() below).

const STATE_DIR_ROOT = path.join(os.tmpdir(), `kra-agent-state-ts-${process.pid}`);
const ORIGINALS_DIR = path.join(STATE_DIR_ROOT, 'originals');
let originalsDirEnsured = false;
let exitCleanupRegistered = false;

function ensureOriginalsDir(): void {
    if (originalsDirEnsured) return;
    fsSync.mkdirSync(ORIGINALS_DIR, { recursive: true });
    originalsDirEnsured = true;
    registerExitCleanup();
    sweepStaleStateDirs();
}

function registerExitCleanup(): void {
    if (exitCleanupRegistered) return;
    exitCleanupRegistered = true;
    const cleanup = (): void => {
        try { fsSync.rmSync(STATE_DIR_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    process.once('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(sig, () => { cleanup(); process.exit(); });
    }
}

// On startup, prune state dirs whose owner pid is no longer alive (covers
// SIGKILL / OOM / hard crashes that bypass our exit handler).
function sweepStaleStateDirs(): void {
    try {
        const root = os.tmpdir();
        const entries = fsSync.readdirSync(root);
        for (const name of entries) {
            const m = /^kra-agent-state-ts-(\d+)$/.exec(name);
            if (!m) continue;
            const pid = Number(m[1]);
            if (!Number.isFinite(pid) || pid === process.pid) continue;
            try {
                process.kill(pid, 0); // throws if pid is gone
            } catch {
                try { fsSync.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

function spillOriginalSync(content: string): string {
    ensureOriginalsDir();
    const sha = crypto.createHash('sha1').update(content, 'utf8').digest('hex');
    const filePath = path.join(ORIGINALS_DIR, `${sha}.bin`);
    if (!fsSync.existsSync(filePath)) {
        fsSync.writeFileSync(filePath, content, 'utf8');
    }

    return sha;
}

async function loadOriginal(sha: string): Promise<string> {
    const filePath = path.join(ORIGINALS_DIR, `${sha}.bin`);

    return await fs.readFile(filePath, 'utf8');
}

function countLineDelta(before: string | null, after: string | null): { added: number; removed: number } {
    const a = before === null ? [] : before.split('\n');
    const b = after === null ? [] : after.split('\n');
    // Cheap, non-LCS estimate that works fine for the picker labels:
    // lines unique to `b` are "added"; lines unique to `a" are "removed".
    const setA = new Map<string, number>();
    for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of b) {
        const n = setA.get(line) ?? 0;
        if (n > 0) setA.set(line, n - 1);
        else added++;
    }
    let removed = 0;
    for (const n of setA.values()) removed += n;

    return { added, removed };
}

export interface BashSnapshot {
    /** git status snapshots keyed by repo cwd. */
    statusByCwd: Map<string, Map<string, string>>;
}

/** One recorded write event for a single path. `kind: 'original'` is the
 *  synthesized pre-session entry; the rest are real recorded mutations. */
export interface VersionEntry {
    kind: 'original' | 'mutation';
    seq: number; // 0 for original, 1..N for mutations in order
    timestamp: number; // ms since epoch (0 for original)
    source: string; // tool source label (writeFile/edit/bash/...)
    /** SHA of pre-write content (null = file did not exist before this write). */
    beforeSha: string | null;
    /** SHA of post-write content (null = file was deleted by this write).
     *  For the synthesized 'original' entry this equals the originalContent SHA. */
    afterSha: string | null;
    addedLines: number;
    removedLines: number;
}

export interface AgentHistory {
    recordMutation: (opts: {
        path: string;
        beforeContent: string | null;
        afterContent: string | null;
        source: string;
    }) => void;
    /** Returns the first-ever recorded `beforeContent` for this path (pre-session state).
     *  Returns `undefined` if the path has never been recorded.
     *  Async because content is spilled to disk to keep heap small. */
    getOriginalContent: (filePath: string) => Promise<string | null | undefined>;
    /** Reverts every path in history back to its pre-session state. */
    revertAll: () => Promise<void>;
    /** All absolute paths that have at least one recorded mutation. */
    listChangedPaths: () => string[];
    /** Returns every recorded version for a path (newest last). The first
     *  entry is always the synthesized pre-session 'original'. */
    listVersions: (filePath: string) => VersionEntry[];
    /** Loads the disk-spilled content for a sha (returned from a VersionEntry). */
    loadVersionContent: (sha: string) => Promise<string>;
    /** Restores the file at `path` to the state captured by `version` (writes to disk).
     *  Returns true on success. Reverts are NOT recorded as new versions — the
     *  version list stays stable so the user can scrub freely. */
    revertToVersion: (filePath: string, version: VersionEntry) => Promise<boolean>;
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
    // First-seen pre-edit content per absolute path. Value is either the SHA
    // of the spilled content (string) or `null` when the file did not exist.
    const originalContent = new Map<string, string | null>();
    // Set of paths that have been mutated this session. Used by listChangedPaths
    // and revertAll. Replaces the old MutationEntry[] which double-stored the
    // before/after bytes for no reason.
    const changedPaths = new Set<string>();
    // Per-path ordered list of recorded write events (excluding the synthesized
    // pre-session 'original' which is rebuilt on demand from originalContent).
    const versionsByPath = new Map<string, VersionEntry[]>();
    let mutationSeq = 0;

    function recordMutation(opts: {
        path: string;
        beforeContent: string | null;
        afterContent: string | null;
        source: string;
    }): void {
        if (!originalContent.has(opts.path)) {
            const sha = opts.beforeContent === null ? null : spillOriginalSync(opts.beforeContent);
            originalContent.set(opts.path, sha);
        }
        changedPaths.add(opts.path);

        const beforeSha = opts.beforeContent === null ? null : spillOriginalSync(opts.beforeContent);
        const afterSha = opts.afterContent === null ? null : spillOriginalSync(opts.afterContent);
        const { added, removed } = countLineDelta(opts.beforeContent, opts.afterContent);

        const entry: VersionEntry = {
            kind: 'mutation',
            seq: ++mutationSeq,
            timestamp: Date.now(),
            source: opts.source,
            beforeSha,
            afterSha,
            addedLines: added,
            removedLines: removed,
        };
        const list = versionsByPath.get(opts.path) ?? [];
        list.push(entry);
        versionsByPath.set(opts.path, list);
    }

    function listVersions(filePath: string): VersionEntry[] {
        if (!originalContent.has(filePath) && !versionsByPath.has(filePath)) return [];
        const originalSha = originalContent.get(filePath) ?? null;
        const original: VersionEntry = {
            kind: 'original',
            seq: 0,
            timestamp: 0,
            source: 'pre-session',
            beforeSha: null,
            afterSha: originalSha,
            addedLines: 0,
            removedLines: 0,
        };
        const muts = versionsByPath.get(filePath) ?? [];

        return [original, ...muts];
    }

    async function loadVersionContent(sha: string): Promise<string> {
        return await loadOriginal(sha);
    }

    async function revertToVersion(filePath: string, version: VersionEntry): Promise<boolean> {
        try {
            // Reverts intentionally do NOT record a new VersionEntry — user wants
            // the version list to stay stable across reverts so they can scrub
            // freely without polluting history with their own undos.
            if (version.afterSha === null) {
                // Target state: file did not exist. Delete from disk.
                await fs.rm(filePath, { force: true });
            } else {
                const content = await loadOriginal(version.afterSha);
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, content, 'utf8');
            }

            return true;
        } catch {
            return false;
        }
    }

    async function getOriginalContent(filePath: string): Promise<string | null | undefined> {
        if (!originalContent.has(filePath)) return undefined;
        const sha = originalContent.get(filePath);
        if (sha === null || sha === undefined) return null;
        try {
            return await loadOriginal(sha);
        } catch {
            return null;
        }
    }

    async function revertAll(): Promise<void> {
        let reverted = 0;
        let failed = 0;

        for (const filePath of changedPaths) {
            try {
                if (!originalContent.has(filePath)) continue;
                const sha = originalContent.get(filePath);

                if (sha === null || sha === undefined) {
                    // File didn't exist originally → delete it.
                    await fs.rm(filePath, { force: true });
                } else {
                    // File existed → restore its original content from disk.
                    const original = await loadOriginal(sha);
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, original, 'utf8');
                }
                reverted++;
            } catch {
                failed++;
            }
        }

        // Caller is responsible for surfacing the result via the TUI host.
        void reverted;
        void failed;
    }

    function listChangedPaths(): string[] {
        return [...changedPaths];
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
        listVersions,
        loadVersionContent,
        revertToVersion,
        bashSnapshotBefore,
        bashSnapshotAfter,
    };
}
