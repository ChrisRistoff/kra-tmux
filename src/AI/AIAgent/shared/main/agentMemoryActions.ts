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
import { editMemory, listMemories, remember, deleteMemory, updateMemory } from '@/AI/AIAgent/shared/memory/notes';
import { MEMORY_KINDS, type MemoryKind } from '@/AI/AIAgent/shared/memory/types';

export type MemoryView = 'all' | 'findings' | 'revisits';

function parseView(raw: unknown): MemoryView {
    const v = String(raw ?? 'all');

    return v === 'findings' || v === 'revisits' ? v : 'all';
}

export async function openMemoryBrowser(nvim: NeovimClient, view: MemoryView = 'all'): Promise<void> {
    const entries = await listMemories({ scope: view, limit: 200 });
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
        [payload as unknown as VimValue, view as unknown as VimValue],
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
    const view = parseView(args['view']);

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

    await openMemoryBrowser(nvim, view);
}

export async function handleDeleteMemory(
    nvim: NeovimClient,
    args: Record<string, unknown>,
): Promise<void> {
    const id = String(args['id'] ?? '').trim();
    const view = parseView(args['view']);

    if (!id) {
        return;
    }

    await deleteMemory(id);
    await nvim.executeLua(
        `local id = select(1, ...); vim.notify('Deleted memory ' .. tostring(id), vim.log.levels.INFO, { title = 'kra-memory' })`,
        [id as unknown as VimValue],
    );

    await openMemoryBrowser(nvim, view);
}

export async function handleEditMemory(
    nvim: NeovimClient,
    args: Record<string, unknown>,
): Promise<void> {
    const id = String(args['id'] ?? '').trim();
    const view = parseView(args['view']);
    if (!id) {
        return;
    }

    const patch: Parameters<typeof editMemory>[0] = { id };
    if (typeof args['title'] === 'string') {
        patch.title = (args['title']).trim();
    }
    if (typeof args['body'] === 'string') {
        patch.body = (args['body']).trim();
    }
    if (typeof args['tags'] === 'string') {
        const t = (args['tags']).trim();
        patch.tags = t ? t.split(',').map((x) => x.trim()).filter(Boolean) : [];
    } else if (Array.isArray(args['tags'])) {
        patch.tags = (args['tags'] as unknown[]).map((x) => String(x));
    }
    if (typeof args['paths'] === 'string') {
        const p = (args['paths']).trim();
        patch.paths = p ? p.split(',').map((x) => x.trim()).filter(Boolean) : [];
    } else if (Array.isArray(args['paths'])) {
        patch.paths = (args['paths'] as unknown[]).map((x) => String(x));
    }

    await editMemory(patch);
    await nvim.executeLua(
        `local id = select(1, ...); vim.notify('Edited memory ' .. tostring(id), vim.log.levels.INFO, { title = 'kra-memory' })`,
        [id as unknown as VimValue],
    );

    await openMemoryBrowser(nvim, view);
}

export async function handleSetMemoryStatus(
    nvim: NeovimClient,
    args: Record<string, unknown>,
): Promise<void> {
    const id = String(args['id'] ?? '').trim();
    const statusRaw = String(args['status'] ?? '').trim();
    const view = parseView(args['view']);

    if (!id || (statusRaw !== 'resolved' && statusRaw !== 'dismissed' && statusRaw !== 'open')) {
        return;
    }

    const resolution = typeof args['resolution'] === 'string' ? (args['resolution']) : undefined;
    const updateInput: Parameters<typeof updateMemory>[0] =
        resolution !== undefined
            ? { id, status: statusRaw, resolution }
            : { id, status: statusRaw };
    await updateMemory(updateInput);

    await openMemoryBrowser(nvim, view);
    return;
}