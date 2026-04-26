/**
 * Bridge between the Neovim chat buffer (<leader>m) and the kra-memory store.
 *
 * The agent prompt-action handler dispatches `browse_memory` / `add_memory`
 * / `delete_memory` here. We talk to LanceDB via the same `notes.ts` helpers
 * the MCP server uses, then drive a Telescope picker in `kra_agent_ui.lua`
 * via `executeLua`.
 */

import type { NeovimClient } from 'neovim';
import type { VimValue } from 'neovim/lib/types/VimValue';
import { recall, remember, deleteMemory } from '@/AI/AIAgent/shared/memory/notes';
import { MEMORY_KINDS, type MemoryKind } from '@/AI/AIAgent/shared/memory/types';

export async function openMemoryBrowser(nvim: NeovimClient): Promise<void> {
    const entries = await recall({ k: 200 });
    const payload = entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        paths: entry.paths,
        status: entry.status,
        createdAt: entry.createdAt,
    }));

    await nvim.executeLua(
        `require('kra_agent_ui').show_memory_browser(...)`,
        [payload as unknown as VimValue],
    );
}

export async function handleAddMemory(
    nvim: NeovimClient,
    args: Record<string, unknown>,
): Promise<void> {
    const kindRaw = String(args['kind'] ?? 'note').trim();
    const kind: MemoryKind = (MEMORY_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as MemoryKind)
        : 'note';
    const title = String(args['title'] ?? '').trim();
    const body = String(args['body'] ?? '').trim();

    if (!title || !body) {
        await nvim.executeLua(
            `vim.notify('Memory: title and body are required', vim.log.levels.WARN, { title = 'kra-memory' })`,
            [],
        );

        return;
    }

    const tagsRaw = String(args['tags'] ?? '').trim();
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    const { id } = await remember({ kind, title, body, tags, source: 'user' });

    await nvim.executeLua(
        `local id = select(1, ...); vim.notify('Saved memory ' .. tostring(id), vim.log.levels.INFO, { title = 'kra-memory' })`,
        [id as unknown as VimValue],
    );
    // Re-open the browser so the user immediately sees the new entry.
    await openMemoryBrowser(nvim);
}

export async function handleDeleteMemory(
    nvim: NeovimClient,
    args: Record<string, unknown>,
): Promise<void> {
    const id = String(args['id'] ?? '').trim();

    if (!id) {
        return;
    }

    await deleteMemory(id);
    await nvim.executeLua(
        `local id = select(1, ...); vim.notify('Deleted memory ' .. tostring(id), vim.log.levels.INFO, { title = 'kra-memory' })`,
        [id as unknown as VimValue],
    );

    await openMemoryBrowser(nvim);
}
