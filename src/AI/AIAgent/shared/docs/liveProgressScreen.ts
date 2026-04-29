/**
 * Live progress screen for `kra ai docs`.
 *
 * Polls `<repo>/.kra-memory/docs-status.json` every ~500 ms and renders a
 * blessed table + scrollable event log. Pure UI: no coordinator side
 * effects beyond the optional `s` keybinding which sends a
 * `shutdown-request` over IPC.
 *
 * Extracted from `commands/manageDocs.ts` to keep the menu file focused
 * on flow control. Behavior is identical to the previous inline version.
 */

import fs from 'fs';
import path from 'path';
import blessed from 'blessed';

import { memoryDirectoryRoot } from '@/AI/AIAgent/shared/memory/db';
import { createIPCClient, IPCsockets } from '../../../../../eventSystem/ipc';
import type { DocsStatusFile, DocsSourceStatus } from './types';

export function statusFilePath(): string {
    return path.join(memoryDirectoryRoot(), 'docs-status.json');
}

export function readSnapshot(): DocsStatusFile | null {
    const file = statusFilePath();
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as DocsStatusFile;
    } catch {
        return null;
    }
}

export function coordinatorAlive(): boolean {
    const snap = readSnapshot();
    if (!snap) return false;
    try {
        process.kill(snap.coordinatorPid, 0);

        return true;
    } catch {
        return false;
    }
}

function indexByAlias(rows: DocsSourceStatus[]): Map<string, DocsSourceStatus> {
    const m = new Map<string, DocsSourceStatus>();
    for (const r of rows) m.set(r.alias, r);

    return m;
}

function tableRow(s: DocsSourceStatus): string[] {
    const url = s.lastUrl ? (s.lastUrl.length > 60 ? s.lastUrl.slice(0, 57) + '...' : s.lastUrl) : '';

    return [
        s.alias,
        s.phase,
        `${s.pagesDone}/${s.pagesTotal}`,
        String(s.chunksWritten),
        String(s.errors),
        s.mode ?? '',
        url,
    ];
}

function diffLines(prev: Map<string, DocsSourceStatus>, next: DocsSourceStatus[]): string[] {
    const out: string[] = [];
    for (const n of next) {
        const p = prev.get(n.alias);
        if (!p) {
            out.push(`[${n.alias}] tracked: phase=${n.phase}`);
            continue;
        }
        if (p.phase !== n.phase) out.push(`[${n.alias}] phase: ${p.phase} \u2192 ${n.phase}`);
        if (n.pagesDone > p.pagesDone) out.push(`[${n.alias}] pages: ${p.pagesDone} \u2192 ${n.pagesDone}/${n.pagesTotal}`);
        if (n.chunksWritten > p.chunksWritten) out.push(`[${n.alias}] chunks: +${n.chunksWritten - p.chunksWritten} (total ${n.chunksWritten})`);
        if (n.errors > p.errors) out.push(`[${n.alias}] error: ${n.lastError ?? '(no message)'}`);
        if (n.phase === 'done' && p.phase !== 'done') out.push(`[${n.alias}] DONE \u2192 ${n.chunksWritten} chunks, ${n.errors} errors`);
    }

    return out;
}

export async function showLiveProgress(): Promise<void> {
    const screen = blessed.screen({ smartCSR: true, title: 'kra-docs · live' });

    const header = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: 1,
        tags: true,
        content: '{bold}kra-docs · live progress{/bold}  —  q/Esc to close · s to stop coordinator',
        style: { fg: 'white', bg: 'blue' },
    });

    const table = blessed.listtable({
        parent: screen,
        top: 1,
        left: 0,
        width: '100%',
        height: '60%',
        keys: false,
        mouse: false,
        align: 'left',
        border: { type: 'line' },
        style: {
            header: { fg: 'cyan', bold: true },
            cell: { fg: 'white' },
            border: { fg: 'gray' },
        },
        data: [['alias', 'phase', 'pages', 'chunks', 'err', 'mode', 'last url']],
    });

    const log = blessed.log({
        parent: screen,
        top: '60%+1',
        left: 0,
        width: '100%',
        bottom: 0,
        border: { type: 'line' },
        label: ' events (j/k · PgUp/PgDn · mouse wheel) ',
        scrollable: true,
        alwaysScroll: true,
        scrollback: 5000,
        keys: true,
        mouse: true,
        vi: true,
        tags: true,
        scrollbar: { ch: ' ', style: { bg: 'cyan' } },
        style: { border: { fg: 'gray' } },
    });
    log.focus();

    let lastByAlias = new Map<string, DocsSourceStatus>();
    let lastUpdatedAt = 0;

    const refresh = (): void => {
        const snap = readSnapshot();
        if (!snap) {
            table.setData([
                ['alias', 'phase', 'pages', 'chunks', 'err', 'mode', 'last url'],
                ['(no active crawl — docs-status.json missing)', '', '', '', '', '', ''],
            ]);
            screen.render();

            return;
        }

        const rows: string[][] = [['alias', 'phase', 'pages', 'chunks', 'err', 'mode', 'last url']];
        for (const s of snap.sources) rows.push(tableRow(s));
        if (snap.sources.length === 0) rows.push(['(no sources tracked yet)', '', '', '', '', '', '']);
        table.setData(rows);

        if (snap.updatedAt !== lastUpdatedAt) {
            const deltas = diffLines(lastByAlias, snap.sources);
            for (const line of deltas) log.add(line);
            lastUpdatedAt = snap.updatedAt;
            lastByAlias = indexByAlias(snap.sources);
        }

        const ageSec = Math.max(0, Math.round((Date.now() - snap.updatedAt) / 1000));
        let alive = false;
        try { process.kill(snap.coordinatorPid, 0); alive = true; } catch { /* dead */ }
        header.setContent(
            `{bold}kra-docs · live progress{/bold}  —  pid ${snap.coordinatorPid} (${alive ? 'running' : 'exited'}) · updated ${ageSec}s ago  —  q/Esc close · s stop · j/k scroll`,
        );
        screen.render();
    };

    refresh();
    const tick = setInterval(refresh, 500);

    const closeAndDestroy = (): void => {
        clearInterval(tick);
        screen.destroy();
    };

    screen.key(['q', 'escape', 'C-c'], closeAndDestroy);
    screen.key(['s'], async (): Promise<void> => {
        try {
            const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
            await client.emit(JSON.stringify({ type: 'shutdown-request' }));
            log.add('{yellow-fg}sent shutdown-request{/yellow-fg}');
            screen.render();
        } catch (err) {
            log.add(`{red-fg}stop failed: ${(err as Error).message}{/red-fg}`);
            screen.render();
        }
    });

    await new Promise<void>((resolve) => {
        screen.on('destroy', () => resolve());
    });
}
