/**
 * `kra ai memory` — interactive blessed UI to manage both:
 *   1. Indexed codebases (registry entries + per-repo code_chunks tables).
 *   2. Long-term memories (memory_findings + memory_revisits tables).
 *
 * Designed as a standalone command so the user can clean up / inspect without
 * launching the agent. Uses the same generalUI helpers as the rest of the CLI.
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import * as lancedb from '@lancedb/lancedb';
import * as ui from '@/UI/generalUI';
import { openVim } from '@/utils/neovimHelper';
import {
    loadRegistry,
    removeRegistryEntry,
    upsertRegistryEntry,
    type RegistryEntry,
} from '@/AI/AIAgent/shared/memory/registry';
import {
    listMemories,
    deleteMemory,
    updateMemory,
    remember,
    editMemory,
} from '@/AI/AIAgent/shared/memory/notes';
import {
    MEMORY_KINDS,
    MEMORY_STATUSES,
    isFindingKind,
    isRevisitKind,
    type MemoryKind,
    type MemoryStatus,
    type MemoryEntry,
} from '@/AI/AIAgent/shared/memory/types';

const BACK = '← Back';
const QUIT = 'Quit';


/**
 * Open `initial` in nvim for editing. Returns the saved contents (or the
 * original if the user wrote nothing). Throws on nvim non-zero exit.
 */
async function editInVim(initial: string, suffix = '.md'): Promise<string> {
    const tmp = path.join(os.tmpdir(), `kra-mem-edit-${Date.now()}${suffix}`);
    await fs.writeFile(tmp, initial, 'utf8');
    try {
        await openVim(tmp);
        const out = await fs.readFile(tmp, 'utf8');

        return out;
    } finally {
        await fs.unlink(tmp).catch(() => undefined);
    }
}

export async function manageMemory(): Promise<void> {
    while (true) {
        const choice = await ui.searchSelectAndReturnFromArray({
            itemsArray: [
                'Manage indexed codebases',
                'Manage long-term memories',
                QUIT,
            ],
            prompt: 'kra-memory',
        });

        if (!choice || choice === QUIT) {
            return;
        }

        if (choice === 'Manage indexed codebases') {
            await manageIndexedRepos();
        } else if (choice === 'Manage long-term memories') {
            await manageLongTermMemories();
        }
    }
}

// ============================================================================
// Indexed codebases
// ============================================================================

async function manageIndexedRepos(): Promise<void> {
    while (true) {
        const reg = await loadRegistry();
        const ids = Object.keys(reg.repos);

        if (ids.length === 0) {
            await ui.showInfoScreen('No repos', 'No indexed codebases yet.\n\nIndex one with: kra ai index');

            return;
        }

        const labelToId = new Map<string, string>();
        const labels: string[] = [];

        for (const id of ids) {
            const e = reg.repos[id];
            const label = `${e.alias}  (${e.rootPath})  -  ${e.chunksCount} chunks`;
            labels.push(label);
            labelToId.set(label, id);
        }
        labels.push(BACK);

        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: labels,
            prompt: 'Indexed codebases',
        });

        if (!picked || picked === BACK) {
            return;
        }

        const id = labelToId.get(picked);
        if (!id) continue;

        await indexedRepoActions(id, reg.repos[id]);
    }
}

async function indexedRepoActions(id: string, entry: RegistryEntry): Promise<void> {
    while (true) {
        const action = await ui.searchSelectAndReturnFromArray({
            itemsArray: [
                'View details',
                'Drop index (delete code_chunks + registry entry)',
                'Reset baseline (force full reindex on next launch)',
                'Rename alias',
                BACK,
            ],
            prompt: entry.alias,
        });

        if (!action || action === BACK) return;

        if (action === 'View details') {
            const details = [
                `alias:               ${entry.alias}`,
                `id:                  ${id}`,
                `rootPath:            ${entry.rootPath}`,
                `lastIndexedCommit:   ${entry.lastIndexedCommit || '(none)'}`,
                `lastIndexedAt:       ${entry.lastIndexedAt ? new Date(entry.lastIndexedAt).toISOString() : '(never)'}`,
                `chunksCount:         ${entry.chunksCount}`,
            ].join('\n');
            await ui.showInfoScreen(entry.alias, details + '\n');
            continue;
        }

        if (action === 'Drop index (delete code_chunks + registry entry)') {
            const ok = await ui.promptUserYesOrNo(
                `Drop the code_chunks table for '${entry.alias}' AND remove it from the registry?\n` +
                `Long-term memories (findings/revisits) will be untouched.`,
            );
            if (!ok) continue;

            const dropped = await dropCodeChunksAt(entry.rootPath);
            await removeRegistryEntry(id);
            console.log(`kra-memory: ${dropped ? 'dropped code_chunks at ' + entry.rootPath : 'no code_chunks table existed'}; registry entry removed.`);

            return;
        }

        if (action === 'Reset baseline (force full reindex on next launch)') {
            const ok = await ui.promptUserYesOrNo(
                `Clear lastIndexedCommit/lastIndexedAt for '${entry.alias}'?\n` +
                `The next agent launch in this repo will trigger a full reindex.`,
            );
            if (!ok) continue;

            await upsertRegistryEntry(id, { lastIndexedCommit: '', lastIndexedAt: 0 });
            console.log(`kra-memory: baseline cleared for '${entry.alias}'`);

            return;
        }

        if (action === 'Rename alias') {
            const next = await ui.askUserForInput(`Enter new alias for '${entry.alias}'`);
            const trimmed = next.trim();
            if (!trimmed) continue;

            await upsertRegistryEntry(id, { alias: trimmed });
            entry.alias = trimmed;
            console.log(`kra-memory: alias updated to '${trimmed}'`);
        }
    }
}

async function dropCodeChunksAt(repoRoot: string): Promise<boolean> {
    try {
        const lanceRoot = path.join(repoRoot, '.kra-memory', 'lance');
        const db = await lancedb.connect(lanceRoot);
        const names = await db.tableNames();
        if (!names.includes('code_chunks')) return false;
        await db.dropTable('code_chunks');

        return true;
    } catch (err) {
        console.warn(`kra-memory: failed to drop code_chunks at ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`);

        return false;
    }
}

// ============================================================================
// Long-term memories
// ============================================================================

async function manageLongTermMemories(): Promise<void> {
    while (true) {
        const scope = await ui.searchSelectAndReturnFromArray({
            itemsArray: ['All', 'Findings', 'Revisits', '+ Add new memory', BACK],
            prompt: 'Long-term memories',
        });

        if (!scope || scope === BACK) return;

        if (scope === '+ Add new memory') {
            await addNewMemory();
            continue;
        }

        const scopeKey: 'all' | 'findings' | 'revisits' =
            scope === 'Findings' ? 'findings' : scope === 'Revisits' ? 'revisits' : 'all';

        await browseMemories(scopeKey);
    }
}

async function browseMemories(scope: 'all' | 'findings' | 'revisits'): Promise<void> {
    while (true) {
        const entries = await listMemories({ scope, limit: 200 });

        if (entries.length === 0) {
            await ui.showInfoScreen('Empty', `No ${scope} memories yet.`);

            return;
        }

        const labelToEntry = new Map<string, MemoryEntry>();
        const labels: string[] = [];

        for (const e of entries) {
            const created = new Date(e.createdAt).toISOString().slice(0, 10);
            const label = `[${e.kind}] ${created} ${e.status === 'open' ? '○' : '●'} ${e.title}`;
            labels.push(label);
            labelToEntry.set(label, e);
        }
        labels.push(BACK);

        const picked = await ui.searchSelectAndReturnFromArray({
            itemsArray: labels,
            prompt: `${scope} memories`,
        });

        if (!picked || picked === BACK) return;

        const entry = labelToEntry.get(picked);
        if (!entry) continue;

        const wasDeleted = await memoryEntryActions(entry);
        if (wasDeleted) {
            // List has changed; loop back to refresh.
            continue;
        }
    }
}

async function memoryEntryActions(entry: MemoryEntry): Promise<boolean> {
    while (true) {
        const action = await ui.searchSelectAndReturnFromArray({
            itemsArray: [
                'View body / details',
                'Edit body in nvim',
                'Change status',
                'Delete memory',
                BACK,
            ],
            prompt: entry.title,
        });

        if (!action || action === BACK) return false;

        if (action === 'View body / details') {
            const lines = [
                `Title:    ${entry.title}`,
                `Kind:     ${entry.kind}`,
                `Status:   ${entry.status}`,
                `Tags:     ${entry.tags.join(', ') || '(none)'}`,
                `Paths:    ${entry.paths.join(', ') || '(none)'}`,
                `Branch:   ${entry.branch || '(none)'}`,
                `Created:  ${new Date(entry.createdAt).toISOString()}`,
                `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
                '',
                '── body ──',
                entry.body,
            ].join('\n');
            await ui.showInfoScreen(entry.title, lines + '\n');
            continue;
        }

        if (action === 'Edit body in nvim') {
            const next = await editInVim(entry.body, '.md');
            const trimmed = next.replace(/\s+$/, '');
            if (trimmed === entry.body) {
                console.log('kra-memory: body unchanged.');
                continue;
            }
            const ok = await ui.promptUserYesOrNo(`Save edited body for '${entry.title}'?`);
            if (!ok) continue;

            await editMemory({ id: entry.id, body: trimmed });
            entry.body = trimmed;
            console.log(`kra-memory: body of '${entry.title}' updated.`);
            continue;
        }

        if (action === 'Change status') {
            const status = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...MEMORY_STATUSES, BACK],
                prompt: 'New status',
            });
            if (!status || status === BACK) continue;

            await updateMemory({ id: entry.id, status: status as MemoryStatus });
            entry.status = status as MemoryStatus;
            console.log(`kra-memory: status of '${entry.title}' set to '${status}'`);
            continue;
        }

        if (action === 'Delete memory') {
            const ok = await ui.promptUserYesOrNo(`Delete memory '${entry.title}'? This cannot be undone.`);
            if (!ok) continue;

            await deleteMemory(entry.id);
            console.log(`kra-memory: deleted '${entry.title}'`);

            return true;
        }
    }
}

async function addNewMemory(): Promise<void> {
    const kind = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...MEMORY_KINDS, BACK],
        prompt: 'Memory kind',
    });
    if (!kind || kind === BACK) return;

    if (!isFindingKind(kind) && !isRevisitKind(kind)) {
        console.log(`kra-memory: unknown kind '${kind}'`);

        return;
    }

    const title = (await ui.askUserForInput('Title (single line, required)')).trim();
    if (!title) {
        console.log('kra-memory: aborted (title required).');

        return;
    }

    const placeholder = `# Body for: ${title}\n# Write the memory body below. Save and quit (:wq) to confirm, or quit without writing (:q!) to abort.\n\n`;
    const raw = await editInVim(placeholder, '.md');

    const body = raw
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .trim();

    if (!body) {
        console.log('kra-memory: aborted (body required).');

        return;
    }

    const tagsRaw = (await ui.askUserForInput('Tags (comma-separated, optional)')).trim();
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    const result = await remember({
        kind: kind as MemoryKind,
        title,
        body,
        tags,
    });
    console.log(`kra-memory: created memory '${title}' (id ${result.id})`);
}
