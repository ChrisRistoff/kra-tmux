/**
 * kra-memory browser overlay (blessed). Keybindings:
 *
 *   - Tab          → cycle view (all → findings → revisits → all)
 *   - a            → add new memory (title → body → tags → kind)
 *   - dd / D       → delete (with / without confirm)
 *   - Enter        → open the per-entry action menu (edit / resolve / …)
 *   - q / Esc      → close
 *
 * Per-entry actions:
 *   t  edit title
 *   b  edit body (full freeform editor)
 *   g  edit tags (csv)
 *   d  delete
 *   r  resolve (revisits only)
 *   x  dismiss (revisits only)
 *   o  reopen  (revisits only)
 *   q  close
 */

import * as blessed from 'blessed';
import { pauseScreenKeys } from '@/UI/dashboard';
import { sanitizeForBlessed } from '@/UI/dashboard';
import {
    listMemories,
    remember,
    deleteMemory,
    editMemory,
    updateMemory,
} from '@/AI/AIAgent/shared/memory/notes';
import {
    MEMORY_KINDS,
    type MemoryEntry,
    type MemoryKind,
} from '@/AI/AIAgent/shared/memory/types';
import { confirmModal, inputModal, multiSelectModal } from './contextsModal';
import { showFreeformInputModal } from './freeformInputModal';
import { BG_PRIMARY, BG_PANEL, BORDER_DIM } from '../theme';

export type MemoryView = 'all' | 'findings' | 'revisits';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function nextView(v: MemoryView): MemoryView {
    if (v === 'all') return 'findings';
    if (v === 'findings') return 'revisits';

    return 'all';
}

async function loadEntries(view: MemoryView): Promise<MemoryEntry[]> {
    const all = await listMemories({ scope: 'all', limit: 500 });
    if (view === 'findings') return all.filter((e) => e.kind !== 'revisit');
    if (view === 'revisits') return all.filter((e) => e.kind === 'revisit');

    return all;
}

function formatRow(e: MemoryEntry): string {
    const icon = e.status === 'open' ? '●' : '·';
    const tags = e.tags && e.tags.length > 0 ? ` #${e.tags.join(' #')}` : '';

    return sanitizeForBlessed(`${icon} [${e.kind}] ${e.title}${tags}`);
}

function formatPreview(e: MemoryEntry): string {
    const created = new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 19);
    const tags = (e.tags ?? []).join(', ');
    const paths = (e.paths ?? []).join(', ');
    const head = [
        `${DIM}id:     ${RESET}${e.id}`,
        `${DIM}kind:   ${RESET}${e.kind}`,
        `${DIM}status: ${RESET}${e.status ?? ''}`,
        `${DIM}tags:   ${RESET}${tags}`,
        `${DIM}paths:  ${RESET}${paths}`,
        `${DIM}created:${RESET} ${created}`,
        '',
        `${BOLD}# ${e.title ?? ''}${RESET}`,
        '',
    ].join('\n');
    const body = sanitizeForBlessed(e.body ?? '');

    return `${head}${body}`;
}

export interface MemoryBrowserOptions {
    initialView?: MemoryView;
    notify?: (msg: string, lingerMs?: number) => void;
}

export async function showMemoryBrowserModal(
    screen: blessed.Widgets.Screen,
    opts: MemoryBrowserOptions = {},
): Promise<void> {
    let view: MemoryView = opts.initialView ?? 'all';
    const notify = opts.notify ?? ((): void => { /* noop */ });

    let entries: MemoryEntry[] = [];
    try {
        entries = await loadEntries(view);
    } catch (err) {
        notify(`memory load failed: ${err instanceof Error ? err.message : String(err)}`, 4000);

        return;
    }

    return new Promise<void>((resolve) => {
        const restoreKeys = pauseScreenKeys(screen, ['q', 'C-c', 'escape', 'enter', 'tab', 'a', 'd']);
        const savedFocus = screen.focused;

        const container = blessed.box({
            parent: screen,
            label: ' kra-memory ',
            top: 'center',
            left: 'center',
            width: '80%',
            height: '80%',
            border: { type: 'line' },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
            tags: false,
        });

        const header = blessed.box({
            parent: container,
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: false,
            style: { fg: 'white', bg: BG_PANEL },
        });

        const list = blessed.list({
            parent: container,
            top: 1,
            left: 0,
            width: '45%',
            bottom: 1,
            border: { type: 'line' },
            keys: false,
            mouse: true,
            tags: false,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: {
                border: { fg: BORDER_DIM },
                selected: { bg: 'cyan', fg: 'black', bold: true },
                item: { fg: 'white' },
                bg: BG_PRIMARY,
            },
            items: [],
        });

        const preview = blessed.box({
            parent: container,
            top: 1,
            left: '45%',
            right: 0,
            bottom: 1,
            border: { type: 'line' },
            tags: false,
            mouse: false,
            scrollable: true,
            alwaysScroll: true,
            scrollbar: { ch: ' ', style: { bg: 'gray' } },
            style: { border: { fg: BORDER_DIM }, bg: BG_PRIMARY },
        });

        const status = blessed.box({
            parent: container,
            bottom: 0,
            left: 0,
            right: 0,
            height: 1,
            tags: false,
            style: { fg: 'gray', bg: BG_PANEL },
        });

        const getSel = (): number => (list as unknown as { selected: number }).selected;

        const refreshHeader = (): void => {
            const counts = { all: entries.length, findings: 0, revisits: 0 };
            for (const e of entries) {
                if (e.kind === 'revisit') counts.revisits++;
                else counts.findings++;
            }
            const tab = (label: string, key: MemoryView): string => {
                const active = key === view;
                const txt = `${label}(${key === 'all' ? counts.all : counts[key]})`;

                return active ? `\x1b[36;1m[${txt}]\x1b[0m` : ` ${txt} `;
            };
            header.setContent(` ${tab('all', 'all')}  ${tab('findings', 'findings')}  ${tab('revisits', 'revisits')}`);
        };

        const refreshStatus = (): void => {
            status.setContent(' Tab view · a add · dd del · D del! · CR actions · q close');
        };

        const refreshList = (): void => {
            list.setItems(entries.map(formatRow));
            if (getSel() >= entries.length) list.select(Math.max(0, entries.length - 1));
        };

        const updatePreview = (): void => {
            const idx = getSel();
            const e = entries[idx];
            preview.setContent(e ? formatPreview(e) : `${DIM}(empty)${RESET}`);
            (preview as unknown as { setScrollPerc: (n: number) => void }).setScrollPerc(0);
        };

        const reload = async (): Promise<void> => {
            try {
                entries = await loadEntries(view);
            } catch (err) {
                notify(`memory load failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
                entries = [];
            }
            refreshHeader();
            refreshList();
            updatePreview();
            screen.render();
        };

        const cleanup = (): void => {
            container.destroy();
            restoreKeys();
            if (savedFocus) {
                try { (savedFocus as { focus: () => void }).focus(); } catch { /* ignore */ }
            }
            screen.render();
            resolve();
        };

        const cycleView = async (): Promise<void> => {
            view = nextView(view);
            await reload();
        };

        const promptAdd = async (): Promise<void> => {
            const title = await inputModal(screen, 'New memory · title', '', 'enter submit · esc cancel');
            if (!title) return;
            const body = await showFreeformInputModal(screen, {
                title: 'New memory · body',
            });
            if (body == null || body.trim() === '') return;
            const tagsRaw = await inputModal(screen, 'New memory · tags (csv, optional)', '', 'enter submit · esc skip');
            const tags = (tagsRaw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
            const kindIdx = await multiSelectModal(screen, 'Kind', [...MEMORY_KINDS]);
            if (!kindIdx || kindIdx.length === 0) return;
            const kind = MEMORY_KINDS[kindIdx[0] as number] as MemoryKind;
            try {
                await remember({ kind, title, body, tags, source: 'user' });
                notify(`memory added (${kind})`, 2000);
                await reload();
            } catch (err) {
                notify(`add failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
            }
        };

        const promptDelete = async (e: MemoryEntry, skipConfirm: boolean): Promise<void> => {
            if (!skipConfirm) {
                const ok = await confirmModal(screen, 'Delete memory', `Delete "${e.title}"?`);
                if (!ok) return;
            }
            try {
                await deleteMemory(e.id);
                notify('memory deleted', 2000);
                await reload();
            } catch (err) {
                notify(`delete failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
            }
        };

        const editTitle = async (e: MemoryEntry): Promise<void> => {
            const v = await inputModal(screen, 'Edit title', e.title, 'enter save · esc cancel');
            if (v == null) return;
            await editMemory({ id: e.id, title: v });
            notify('title saved', 1500);
            await reload();
        };

        const editBody = async (e: MemoryEntry): Promise<void> => {
            const v = await showFreeformInputModal(screen, {
                title: `Edit body · ${e.title}`,
                initial: e.body ?? '',
            });
            if (v == null) return;
            await editMemory({ id: e.id, body: v });
            notify('body saved', 1500);
            await reload();
        };

        const editTags = async (e: MemoryEntry): Promise<void> => {
            const v = await inputModal(screen, 'Edit tags (csv)', (e.tags ?? []).join(','), 'enter save · esc cancel');
            if (v == null) return;
            const tags = v.split(',').map((t) => t.trim()).filter(Boolean);
            await editMemory({ id: e.id, tags });
            notify('tags saved', 1500);
            await reload();
        };

        const setStatus = async (
            e: MemoryEntry,
            newStatus: 'resolved' | 'dismissed' | 'open',
            askReason: boolean,
        ): Promise<void> => {
            if (e.kind !== 'revisit') {
                notify(`${newStatus} only applies to revisits`, 2500);

                return;
            }
            let resolution = '';
            if (askReason) {
                const v = await inputModal(
                    screen,
                    newStatus === 'resolved' ? 'Resolution note (optional)' : 'Reason (optional)',
                    '',
                    'enter submit · esc skip',
                );
                if (v == null) return;
                resolution = v;
            }
            try {
                await updateMemory({
                    id: e.id,
                    status: newStatus,
                    ...(resolution ? { resolution } : {}),
                });
                notify(`marked ${newStatus}`, 2000);
                await reload();
            } catch (err) {
                notify(`update failed: ${err instanceof Error ? err.message : String(err)}`, 4000);
            }
        };

        const openActions = async (): Promise<void> => {
            const idx = getSel();
            const e = entries[idx];
            if (!e) return;
            const isRevisit = e.kind === 'revisit';
            const items = [
                't · edit title',
                'b · edit body',
                'g · edit tags',
                'd · delete',
                ...(isRevisit
                    ? ['r · resolve', 'x · dismiss', 'o · reopen']
                    : []),
            ];
            // Reserve action by char rather than index — multiSelectModal in
            // single-select returns the highlighted index, but we also support
            // direct letter keys via a separate modal. Use multiSelect as a
            // visual menu and translate index back to action.
            const sel = await multiSelectModal(screen, `Actions · ${e.title}`, items);
            if (!sel || sel.length === 0) return;
            const choice = items[sel[0] as number] ?? '';
            if (choice.startsWith('t')) await editTitle(e);
            else if (choice.startsWith('b')) await editBody(e);
            else if (choice.startsWith('g')) await editTags(e);
            else if (choice.startsWith('d')) await promptDelete(e, false);
            else if (choice.startsWith('r')) await setStatus(e, 'resolved', true);
            else if (choice.startsWith('x')) await setStatus(e, 'dismissed', true);
            else if (choice.startsWith('o')) await setStatus(e, 'open', false);
        };

        list.on('select item', () => updatePreview());

        list.key(['escape', 'q', 'C-c'], () => cleanup());
        list.key(['up', 'k', 'C-p'], () => { list.up(1); updatePreview(); screen.render(); });
        list.key(['down', 'j', 'C-n'], () => { list.down(1); updatePreview(); screen.render(); });
        list.key(['pageup', 'C-u'], () => { list.up(10); updatePreview(); screen.render(); });
        list.key(['pagedown', 'C-d'], () => { list.down(10); updatePreview(); screen.render(); });
        list.key(['S-down'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(1); screen.render(); });
        list.key(['S-up'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(-1); screen.render(); });
        list.key(['S-right'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(10); screen.render(); });
        list.key(['S-left'], () => { (preview as unknown as { scroll: (n: number) => void }).scroll(-10); screen.render(); });

        list.key(['tab'], () => { void cycleView(); });
        list.key(['a'], () => { void promptAdd(); });
        list.key(['enter'], () => { void openActions(); });

        // dd: two consecutive 'd' presses within 600ms = delete with confirm.
        let lastD = 0;
        list.key(['d'], () => {
            const now = Date.now();
            const e = entries[getSel()];
            if (!e) return;
            if (now - lastD < 600) {
                lastD = 0;
                void promptDelete(e, false);

                return;
            }
            lastD = now;
            notify('press d again to delete', 1200);
        });
        list.key(['S-d'], () => {
            const e = entries[getSel()];
            if (!e) return;
            void promptDelete(e, true);
        });

        refreshHeader();
        refreshList();
        refreshStatus();
        updatePreview();
        list.focus();
        screen.render();
    });
}
