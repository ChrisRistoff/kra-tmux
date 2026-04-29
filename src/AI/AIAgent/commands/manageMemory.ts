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
import { menuChain, UserCancelled } from '@/UI/menuChain';
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
    type MemoryStatus,
    type MemoryEntry,
} from '@/AI/AIAgent/shared/memory/types';

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
    await menuChain()
        .step('action', async () => {
            const choice = await ui.searchSelectAndReturnFromArray({
                itemsArray: [
                    'Manage indexed codebases',
                    'Manage long-term memories',
                ],
                prompt: 'kra-memory',
            });

            if (!choice) throw new UserCancelled();

            return choice;
        })
        .step('_', async ({ action }) => {
            if (action === 'Manage indexed codebases') await manageIndexedRepos();
            else if (action === 'Manage long-term memories') await manageLongTermMemories();

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

// ============================================================================
// Indexed codebases
// ============================================================================

async function manageIndexedRepos(): Promise<void> {
    await menuChain()
        .step('pick', async () => {
            const reg = await loadRegistry();
            const ids = Object.keys(reg.repos);

            if (ids.length === 0) {
                await ui.showInfoScreen('No repos', 'No indexed codebases yet.\n\nIndex one with: kra ai index');
                throw new UserCancelled();
            }

            const labelToId = new Map<string, string>();
            const labels: string[] = [];

            for (const id of ids) {
                const e = reg.repos[id];
                const label = `${e.alias}  (${e.rootPath})  -  ${e.chunksCount} chunks`;
                labels.push(label);
                labelToId.set(label, id);
            }

            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: labels,
                prompt: 'Indexed codebases',
            });

            if (!picked) throw new UserCancelled();

            const id = labelToId.get(picked) ?? '';

            return { id, entry: reg.repos[id] };
        })
        .step('_', async ({ pick }) => {
            const { id, entry } = pick as { id: string; entry: RegistryEntry };
            await indexedRepoActions(id, entry);

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function indexedRepoActions(id: string, entry: RegistryEntry): Promise<void> {
    await menuChain()
        .step('action', async () => {
            const action = await ui.searchSelectAndReturnFromArray({
                itemsArray: [
                    '(VIEW) details',
                    '(DROP) index (delete code_chunks + registry entry)',
                    '(RESET) baseline (force full reindex on next launch)',
                    '(RENAME) alias',
                ],
                prompt: entry.alias,
            });

            if (!action) throw new UserCancelled();

            return action;
        })
        .step('_', async ({ action }) => {
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

                throw new UserCancelled();
            }

            if (action === 'Drop index (delete code_chunks + registry entry)') {
                const ok = await ui.promptUserYesOrNo(
                    `Drop the code_chunks table for '${entry.alias}' AND remove it from the registry?\n` +
                    `Long-term memories (findings/revisits) will be untouched.`,
                );
                if (!ok) throw new UserCancelled();

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
                if (!ok) throw new UserCancelled();

                await upsertRegistryEntry(id, { lastIndexedCommit: '', lastIndexedAt: 0 });
                console.log(`kra-memory: baseline cleared for '${entry.alias}'`);

                return;
            }

            if (action === 'Rename alias') {
                const next = await ui.askUserForInput(`Enter new alias for '${entry.alias}'`);
                const trimmed = next.trim();
                if (!trimmed) throw new UserCancelled();

                await upsertRegistryEntry(id, { alias: trimmed });
                entry.alias = trimmed;
                console.log(`kra-memory: alias updated to '${trimmed}'`);

                throw new UserCancelled();
            }
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
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
    await menuChain()
        .step('scope', async () => {
            const scope = await ui.searchSelectAndReturnFromArray({
                itemsArray: ['All', 'Findings', 'Revisits', '+ Add new memory'],
                prompt: 'Long-term memories',
            });

            if (!scope) throw new UserCancelled();

            return scope;
        })
        .step('_', async ({ scope }) => {
            if (scope === '+ Add new memory') {
                await addNewMemory();
                throw new UserCancelled();
            }

            const scopeKey: 'all' | 'findings' | 'revisits' =
                scope === 'Findings' ? 'findings' : scope === 'Revisits' ? 'revisits' : 'all';

            await browseMemories(scopeKey);

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function browseMemories(scope: 'all' | 'findings' | 'revisits'): Promise<void> {
    await menuChain()
        .step('pick', async () => {
            const entries = await listMemories({ scope, limit: 200 });

            if (entries.length === 0) {
                await ui.showInfoScreen('Empty', `No ${scope} memories yet.`);
                throw new UserCancelled();
            }

            const labelToEntry = new Map<string, MemoryEntry>();
            const labels: string[] = [];

            for (const e of entries) {
                const created = new Date(e.createdAt).toISOString().slice(0, 10);
                const label = `[${e.kind}] ${created} ${e.status === 'open' ? '○' : '●'} ${e.title}`;
                labels.push(label);
                labelToEntry.set(label, e);
            }

            const picked = await ui.searchSelectAndReturnFromArray({
                itemsArray: labels,
                prompt: `${scope} memories`,
            });

            if (!picked) throw new UserCancelled();

            const entry = labelToEntry.get(picked);
            if (!entry) throw new UserCancelled();

            return entry;
        })
        .step('_', async ({ pick }) => {
            await memoryEntryActions(pick);

            throw new UserCancelled();
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function memoryEntryActions(entry: MemoryEntry): Promise<void> {
    await menuChain()
        .step('action', async () => {
            const action = await ui.searchSelectAndReturnFromArray({
                itemsArray: [
                    'View body / details',
                    'Edit body in nvim',
                    'Change status',
                    'Delete memory',
                ],
                prompt: entry.title,
            });

            if (!action) throw new UserCancelled();

            return action;
        })
        .step('_', async ({ action }) => {
            if (action === 'View body / details') {
                const lines = [
                    `Title:    ${entry.title}`,
                    `Kind:     ${entry.kind}`,
                    `Status:   ${entry.status}`,
                    `Tags:     ${entry.tags.join(', ') || '(none)'}`,
                    `Paths:    ${entry.paths.join(', ') || '(none)'}`,
                    `Branch:   ${entry.branch ?? '(none)'}`,
                    `Created:  ${new Date(entry.createdAt).toISOString()}`,
                    `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
                    '',
                    '── body ──',
                    entry.body,
                ].join('\n');
                await ui.showInfoScreen(entry.title, lines + '\n');

                throw new UserCancelled();
            }

            if (action === 'Edit body in nvim') {
                const next = await editInVim(entry.body, '.md');
                const trimmed = next.replace(/\s+$/, '');
                if (trimmed === entry.body) {
                    console.log('kra-memory: body unchanged.');
                    throw new UserCancelled();
                }

                const ok = await ui.promptUserYesOrNo(`Save edited body for '${entry.title}'?`);
                if (!ok) throw new UserCancelled();

                await editMemory({ id: entry.id, body: trimmed });
                entry.body = trimmed;
                console.log(`kra-memory: body of '${entry.title}' updated.`);

                throw new UserCancelled();
            }

            if (action === 'Change status') {
                const status = await ui.searchSelectAndReturnFromArray({
                    itemsArray: [...MEMORY_STATUSES],
                    prompt: 'New status',
                });
                if (!status) throw new UserCancelled();

                await updateMemory({ id: entry.id, status: status as MemoryStatus });
                entry.status = status as MemoryStatus;
                console.log(`kra-memory: status of '${entry.title}' set to '${status}'`);

                throw new UserCancelled();
            }

            if (action === 'Delete memory') {
                const ok = await ui.promptUserYesOrNo(`Delete memory '${entry.title}'? This cannot be undone.`);
                if (!ok) throw new UserCancelled();

                await deleteMemory(entry.id);
                console.log(`kra-memory: deleted '${entry.title}'`);
            }
        })
        .run()
        .catch((e) => { if (!(e instanceof UserCancelled)) throw e; });
}

async function addNewMemory(): Promise<void> {
    const result = await menuChain()
        .step('kind', async () => {
            const kind = await ui.searchSelectAndReturnFromArray({
                itemsArray: [...MEMORY_KINDS],
                prompt: 'Memory kind',
            });

            if (!kind) throw new UserCancelled();
            if (!isFindingKind(kind) && !isRevisitKind(kind)) {
                console.log(`kra-memory: unknown kind '${kind}'`);
                throw new UserCancelled();
            }

            return kind;
        })
        .step('title', async () => {
            const title = (await ui.askUserForInput('Title (single line, required)')).trim();

            if (!title) {
                console.log('kra-memory: title required.');
                throw new UserCancelled();
            }

            return title;
        })
        .step('body', async ({ title }) => {
            const placeholder = `# Body for: ${title}\n# Write the memory body below. Save and quit (:wq) to confirm, or quit without writing (:q!) to abort.\n\n`;
            const raw = await editInVim(placeholder, '.md');

            const body = raw
                .split('\n')
                .filter((l) => !l.startsWith('#'))
                .join('\n')
                .trim();

            if (!body) {
                console.log('kra-memory: body required.');
                throw new UserCancelled();
            }

            return body;
        })
        .step('tags', async () => {
            const tagsRaw = (await ui.askUserForInput('Tags (comma-separated, optional)')).trim();

            return tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        })
        .run();

    const saved = await remember({
        kind: result.kind,
        title: result.title,
        body: result.body,
        tags: result.tags,
    });

    console.log(`kra-memory: created memory '${result.title}' (id ${saved.id})`);
}
