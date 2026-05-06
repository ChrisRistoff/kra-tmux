import * as fs from 'fs/promises';
import * as path from 'path';
import { execCommand } from '@/utils/bashHelper';
import { pickList } from '@/UI/dashboard/pickList';
import { getRepoIdentity, getRegistryEntry } from '@/AI/AIAgent/shared/memory/registry';
import { computeRepoKey } from '@/AI/AIAgent/shared/memory/repoKey';
import { countCodeChunks } from '@/AI/AIAgent/shared/memory/db';

const DONE_SENTINEL = '✓ Done';
const CANCEL_SENTINEL = '✗ Cancel';
const DEFAULT_SCAN_DEPTH = 2;
const DEFAULT_MAX_REPOS = 200;

export interface SelectRepoRootsOptions {
    /** Directory to start the search from. Defaults to process.cwd(). */
    cwd?: string;
    /** Maximum directory depth (1 = direct children only). Defaults to 2. */
    maxDepth?: number;
    /** Cap on number of repos returned by the scan. Defaults to 200. */
    maxRepos?: number;
}

/**
 * Resolve the agent workspace as one or more git repository roots.
 *
 * - If the current directory is inside a git repo: returns just that repo
 *   (preserves single-repo behavior).
 * - Otherwise: scans child directories for `.git` and lets the user
 *   multi-select. Returns the chosen list (always >= 1 entry on success).
 *
 * Throws when no repos are found or the user cancels.
 */
export async function selectRepoRoots(opts: SelectRepoRootsOptions = {}): Promise<string[]> {
    const cwd = path.resolve(opts.cwd ?? process.cwd());

    const inRepo = await tryGitToplevel(cwd);
    if (inRepo) {
        return [inRepo];
    }

    const candidates = await scanForGitRepos(cwd, {
        maxDepth: opts.maxDepth ?? DEFAULT_SCAN_DEPTH,
        maxRepos: opts.maxRepos ?? DEFAULT_MAX_REPOS,
    });

    if (candidates.length === 0) {
        throw new Error(
            `kra ai agent: no git repositories found.\n` +
            `  Current directory (${cwd}) is not inside a git repo,\n` +
            `  and no child directories with a .git folder were found ` +
            `within depth ${opts.maxDepth ?? DEFAULT_SCAN_DEPTH}.`
        );
    }

    return promptMultiSelect(candidates, cwd);
}

async function tryGitToplevel(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execCommand(`git -C "${escapeShell(cwd)}" rev-parse --show-toplevel`);
        const trimmed = stdout.trim();

        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

interface ScanOptions {
    maxDepth: number;
    maxRepos: number;
}

async function scanForGitRepos(root: string, opts: ScanOptions): Promise<string[]> {
    const found: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > opts.maxDepth || found.length >= opts.maxRepos) {
            return;
        }

        let entries: import('fs').Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }

            const childPath = path.join(dir, entry.name);
            const gitPath = path.join(childPath, '.git');

            let isRepo = false;
            try {
                const stat = await fs.stat(gitPath);
                isRepo = stat.isDirectory() || stat.isFile();
            } catch {
                isRepo = false;
            }

            if (isRepo) {
                found.push(childPath);
                if (found.length >= opts.maxRepos) {
                    return;
                }
                continue;
            }

            await walk(childPath, depth + 1);
            if (found.length >= opts.maxRepos) {
                return;
            }
        }
    }

    await walk(root, 1);
    found.sort((a, b) => a.localeCompare(b));

    return found;
}

async function promptMultiSelect(candidates: string[], baseDir: string): Promise<string[]> {
    const selected = new Set<string>();

    const buildItems = (): string[] => [
        renderDoneItem(selected.size),
        CANCEL_SENTINEL,
        ...candidates.map((repo) => renderRepoItem(repo, baseDir, selected.has(repo))),
    ];

    const result = await pickList({
        title: 'Select repos for the agent workspace',
        header: 'Select repos: SPACE toggles · ENTER on “✓ Done” confirms · q cancels',
        items: buildItems(),
        footerChips: 'space: toggle · enter on Done: confirm · ↑/↓ navigate · s// search · q cancel',
        canSubmit: (item) => item === CANCEL_SENTINEL || item.startsWith(DONE_SENTINEL),
        showDetailsPanel: true,
        detailsUseTags: true,
        details: async (item) => repoDetailsForItem(item, baseDir, candidates),
        actions: [
            {
                id: 'toggle',
                keys: ['space', 'x'],
                label: 'space: toggle',
                run: (item, _screen, ctx) => {
                    if (!item) return;
                    if (item === CANCEL_SENTINEL || item.startsWith(DONE_SENTINEL)) return;
                    const repo = parseRepoFromItem(item, baseDir, candidates);
                    if (!repo) return;
                    if (selected.has(repo)) selected.delete(repo);
                    else selected.add(repo);
                    ctx.setItems(buildItems());
                },
            },
        ],
    });

    const choice = result.value;
    if (!choice || choice === CANCEL_SENTINEL) {
        throw new Error('kra ai agent: repo selection cancelled.');
    }

    if (choice.startsWith(DONE_SENTINEL)) {
        if (selected.size === 0) {
            throw new Error('kra ai agent: no repos selected.');
        }

        return [...selected];
    }

    throw new Error('kra ai agent: repo selection cancelled.');
}

function renderDoneItem(count: number): string {
    return count > 0
        ? `${DONE_SENTINEL} (${count} selected)`
        : `${DONE_SENTINEL} (select at least one)`;
}

function renderRepoItem(repo: string, baseDir: string, isSelected: boolean): string {
    const marker = isSelected ? '[x]' : '[ ]';
    const display = path.relative(baseDir, repo) || repo;

    return `${marker} ${display}`;
}

function parseRepoFromItem(item: string, baseDir: string, candidates: string[]): string | null {
    const stripped = item.replace(/^\[[ x]\]\s+/, '');
    const absolute = path.isAbsolute(stripped) ? stripped : path.join(baseDir, stripped);
    const normalized = path.resolve(absolute);

    return candidates.find((c) => path.resolve(c) === normalized) ?? null;
}

async function repoDetailsForItem(item: string | null, baseDir: string, candidates: string[]): Promise<string> {
    if (!item) return '';
    if (item === CANCEL_SENTINEL) return '{gray-fg}Cancel and exit without launching the agent.{/gray-fg}';
    if (item.startsWith(DONE_SENTINEL)) {
        return '{gray-fg}Press {bold}enter{/bold} on this row to launch the agent with the currently-selected repos.{/gray-fg}';
    }

    const repo = parseRepoFromItem(item, baseDir, candidates);
    if (!repo) return '';

    try {
        const identity = await getRepoIdentity(repo);
        const repoKey = computeRepoKey(identity.id);
        const [registry, chunkCount] = await Promise.all([
            getRegistryEntry(identity.id),
            countCodeChunks(repoKey).catch(() => 0),
        ]);

        const lines: string[] = [];
        lines.push(`{bold}${identity.alias}{/bold}`);
        lines.push(`{gray-fg}${repo}{/gray-fg}`);
        lines.push('');
        lines.push(`indexed chunks : ${chunkCount}`);
        if (registry?.lastIndexedAt) {
            const dt = new Date(registry.lastIndexedAt).toISOString().replace('T', ' ').slice(0, 19);
            lines.push(`last indexed   : ${dt} UTC`);
        } else {
            lines.push(`last indexed   : {yellow-fg}never{/yellow-fg}`);
        }
        if (registry?.lastIndexedCommit) {
            lines.push(`last commit    : ${registry.lastIndexedCommit.slice(0, 12)}`);
        }
        lines.push(`repo key       : ${repoKey}`);

        return lines.join('\n');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        return `{red-fg}details unavailable: ${msg}{/red-fg}`;
    }
}

function escapeShell(s: string): string {
    return s.replace(/(["\\$`])/g, '\\$1');
}
