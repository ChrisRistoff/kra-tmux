/**
 * Live progress dashboard for `kra ai docs`.
 *
 * Polls `~/.kra/.kra-memory/docs/docs-status.json` every ~500 ms and renders the
 * crawl through the shared dashboard shell so it matches the rest of the UI.
 */

import fs from 'fs';
import blessed from 'blessed';

import {
    awaitScreenDestroy,
    attachFocusCycleKeys,
    attachVerticalNavigation,
    createDashboardScreen,
    createDashboardShell,
    escTag,
} from '@/UI/dashboard';
import { kraDocsStatusPath } from '@/filePaths';
import { createIPCClient, IPCsockets } from '../../../../../eventSystem/ipc';
import type { DocsStatusFile, DocsSourceStatus } from './types';

export function statusFilePath(): string {
    return kraDocsStatusPath;
}

export async function readSnapshot(): Promise<DocsStatusFile | null> {
    const file = statusFilePath();
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as DocsStatusFile;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return null;
    }
}

export async function coordinatorAlive(): Promise<boolean> {
    const snap = await readSnapshot();
    if (!snap) return false;
    try {
        process.kill(snap.coordinatorPid, 0);

        return true;
    } catch {
        return false;
    }
}

function indexByAlias(rows: DocsSourceStatus[]): Map<string, DocsSourceStatus> {
    const byAlias = new Map<string, DocsSourceStatus>();
    for (const row of rows) byAlias.set(row.alias, row);

    return byAlias;
}

function phaseColor(phase: DocsSourceStatus['phase']): string {
    switch (phase) {
        case 'queued': return 'white';
        case 'crawling': return 'cyan';
        case 'embedding': return 'yellow';
        case 'done': return 'green';
        case 'error': return 'red';
    }
}

function formatSourceRow(source: DocsSourceStatus): string {
    const pages = `${source.pagesDone}/${source.pagesTotal || '?'}`;
    const mode = source.mode ? ` {magenta-fg}${source.mode}{/magenta-fg}` : '';

    return [
        `{bold}${escTag(source.alias)}{/bold}`,
        ` {${phaseColor(source.phase)}-fg}${escTag(source.phase)}{/${phaseColor(source.phase)}-fg}`,
        ` {gray-fg}${escTag(pages)} pages{/gray-fg}`,
        ` {yellow-fg}${source.chunksWritten}{/yellow-fg} chunks`,
        source.errors > 0 ? ` {red-fg}${source.errors} err{/red-fg}` : '',
        mode,
    ].join('');
}

function formatOverview(snap: DocsStatusFile | null): string {
    if (!snap) return '{gray-fg}No active crawl. Start one from kra ai docs.{/gray-fg}';

    const queued = snap.sources.filter((source) => source.phase === 'queued').length;
    const crawling = snap.sources.filter((source) => source.phase === 'crawling' || source.phase === 'embedding').length;
    const done = snap.sources.filter((source) => source.phase === 'done').length;
    const errors = snap.sources.filter((source) => source.phase === 'error').length;
    const pagesDone = snap.sources.reduce((sum, source) => sum + source.pagesDone, 0);
    const pagesTotal = snap.sources.reduce((sum, source) => sum + source.pagesTotal, 0);
    const chunks = snap.sources.reduce((sum, source) => sum + source.chunksWritten, 0);
    const ageSec = Math.max(0, Math.round((Date.now() - snap.updatedAt) / 1000));

    return [
        `{cyan-fg}coordinator{/cyan-fg}  {white-fg}${snap.coordinatorPid}{/white-fg}`,
        `{cyan-fg}updated{/cyan-fg}      {yellow-fg}${ageSec}s ago{/yellow-fg}`,
        `{cyan-fg}sources{/cyan-fg}      {white-fg}${snap.sources.length}{/white-fg}`,
        `{cyan-fg}queued{/cyan-fg}       {white-fg}${queued}{/white-fg}`,
        `{cyan-fg}active{/cyan-fg}       {cyan-fg}${crawling}{/cyan-fg}`,
        `{cyan-fg}done{/cyan-fg}         {green-fg}${done}{/green-fg}`,
        `{cyan-fg}errors{/cyan-fg}       ${errors > 0 ? `{red-fg}${errors}{/red-fg}` : '{green-fg}0{/green-fg}'}`,
        `{cyan-fg}pages{/cyan-fg}        {white-fg}${pagesDone}/${pagesTotal || '?'}{/white-fg}`,
        `{cyan-fg}chunks{/cyan-fg}       {yellow-fg}${chunks}{/yellow-fg}`,
    ].join('\n');
}
function formatSelectedSource(source: DocsSourceStatus | null): string {
    if (!source) return '{gray-fg}Select a source to inspect its live status.{/gray-fg}';

    const elapsedMs = (source.finishedAt ?? Date.now()) - (source.startedAt ?? Date.now());
    const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));

    return [
        `{cyan-fg}alias{/cyan-fg}        {bold}${escTag(source.alias)}{/bold}`,
        `{cyan-fg}phase{/cyan-fg}        {${phaseColor(source.phase)}-fg}${escTag(source.phase)}{/${phaseColor(source.phase)}-fg}`,
        `{cyan-fg}pages{/cyan-fg}        {white-fg}${source.pagesDone}/${source.pagesTotal || '?'}{/white-fg}`,
        `{cyan-fg}chunks{/cyan-fg}       {yellow-fg}${source.chunksWritten}{/yellow-fg}`,
        `{cyan-fg}errors{/cyan-fg}       ${source.errors > 0 ? `{red-fg}${source.errors}{/red-fg}` : '{green-fg}0{/green-fg}'}`,
        `{cyan-fg}mode{/cyan-fg}         {magenta-fg}${escTag(source.mode ?? 'pending')}{/magenta-fg}`,
        `{cyan-fg}elapsed{/cyan-fg}      {white-fg}${elapsedSec}s{/white-fg}`,
        '',
        `{cyan-fg}last url{/cyan-fg}`,
        source.lastUrl ? `{white-fg}${escTag(source.lastUrl)}{/white-fg}` : '{gray-fg}(waiting for first page){/gray-fg}',
        '',
        `{cyan-fg}last error{/cyan-fg}`,
        source.lastError ? `{red-fg}${escTag(source.lastError)}{/red-fg}` : '{gray-fg}(none){/gray-fg}',
    ].join('\n');
}

function diffLines(prev: Map<string, DocsSourceStatus>, next: DocsSourceStatus[]): string[] {
    const out: string[] = [];
    for (const current of next) {
        const previous = prev.get(current.alias);
        const alias = `{cyan-fg}[${escTag(current.alias)}]{/cyan-fg}`;
        if (!previous) {
            out.push(`${alias} tracking started ({${phaseColor(current.phase)}-fg}${escTag(current.phase)}{/${phaseColor(current.phase)}-fg})`);
            continue;
        }
        if (previous.phase !== current.phase) {
            out.push(`${alias} phase {yellow-fg}${escTag(previous.phase)}{/yellow-fg} -> {${phaseColor(current.phase)}-fg}${escTag(current.phase)}{/${phaseColor(current.phase)}-fg}`);
        }
        if (current.pagesDone > previous.pagesDone) {
            out.push(`${alias} pages {white-fg}${previous.pagesDone}{/white-fg} -> {white-fg}${current.pagesDone}/${current.pagesTotal || '?'}{/white-fg}`);
        }
        if (current.chunksWritten > previous.chunksWritten) {
            out.push(`${alias} chunks +{yellow-fg}${current.chunksWritten - previous.chunksWritten}{/yellow-fg} (total {yellow-fg}${current.chunksWritten}{/yellow-fg})`);
        }
        if (current.errors > previous.errors) {
            out.push(`${alias} {red-fg}error{/red-fg} ${escTag(current.lastError ?? '(no message)')}`);
        }
        if (current.phase === 'done' && previous.phase !== 'done') {
            out.push(`${alias} {green-fg}done{/green-fg} -> ${current.chunksWritten} chunks, ${current.errors} errors`);
        }
    }

    return out;
}

export async function showLiveProgress(): Promise<void> {
    const screen = createDashboardScreen({ title: 'kra-docs · live' });
    const shell = createDashboardShell({
        screen,
        listLabel: 'sources',
        listFocusName: 'sources',
        listWidth: '38%',
        listItems: [],
        listTags: true,
        search: false,
        detailPanels: [
            { label: 'crawl overview', focusName: 'overview' },
            { label: 'selected source', focusName: 'selected' },
            { label: 'events', focusName: 'events' },
        ],
        keymapText: () =>
            `{cyan-fg}tab{/cyan-fg} cycle  {cyan-fg}j/k{/cyan-fg} nav/scroll  ` +
            `{cyan-fg}[ ]{/cyan-fg} ±10  {cyan-fg}{ }{/cyan-fg} ±100  ` +
            `{cyan-fg}s{/cyan-fg} stop coordinator  {cyan-fg}q{/cyan-fg} close`,
    });
    const { header, list, ring } = shell;
    const [overviewPanel, selectedPanel, eventsPanel] = shell.detailPanels;

    let currentSnapshot: DocsStatusFile | null = null;
    let currentSources: DocsSourceStatus[] = [];
    let lastByAlias = new Map<string, DocsSourceStatus>();
    let lastUpdatedAt = 0;
    let selectedAlias: string | null = null;
    const eventLines: string[] = [];

    const pushEvents = (lines: string[]): void => {
        if (lines.length === 0) return;
        eventLines.push(...lines.map((line) => `{gray-fg}${new Date().toLocaleTimeString()}{/gray-fg} ${line}`));
        if (eventLines.length > 300) eventLines.splice(0, eventLines.length - 300);
        eventsPanel.setContent(eventLines.length > 0 ? eventLines.join('\n') : '{gray-fg}Waiting for crawl events...{/gray-fg}');
        eventsPanel.setScrollPerc(100);
    };

    const renderPanels = (): void => {
        overviewPanel.setContent(formatOverview(currentSnapshot));
        const selected = currentSources.find((source) => source.alias === selectedAlias) ?? currentSources[0] ?? null;
        selectedPanel.setContent(formatSelectedSource(selected));
        if (eventLines.length === 0) eventsPanel.setContent('{gray-fg}Waiting for crawl events...{/gray-fg}');
    };

    const refresh = async (): Promise<void> => {
        currentSnapshot = await readSnapshot();
        if (!currentSnapshot) {
            currentSources = [];
            list.clearItems();
            list.setItems(['{gray-fg}(no active crawl){/gray-fg}']);
            list.select(0);
            header.setContent(' {magenta-fg}{bold}◆ kra-docs{/bold}{/magenta-fg}   {yellow-fg}no active crawl{/yellow-fg}   {gray-fg}q close · s stop{/gray-fg}');
            renderPanels();
            screen.render();

            return;
        }

        currentSources = currentSnapshot.sources;
        const previousSelection = selectedAlias;
        const rows = currentSources.length > 0
            ? currentSources.map(formatSourceRow)
            : ['{gray-fg}(no sources tracked yet){/gray-fg}'];
        list.clearItems();
        list.setItems(rows);

        const restoreIndex = previousSelection
            ? currentSources.findIndex((source) => source.alias === previousSelection)
            : 0;
        const nextIndex = restoreIndex >= 0 ? restoreIndex : 0;
        list.select(nextIndex);
        selectedAlias = currentSources[nextIndex]?.alias ?? null;

        if (currentSnapshot.updatedAt !== lastUpdatedAt) {
            pushEvents(diffLines(lastByAlias, currentSources));
            lastUpdatedAt = currentSnapshot.updatedAt;
            lastByAlias = indexByAlias(currentSources);
        }

        const alive = await coordinatorAlive();
        const active = currentSources.filter((source) => source.phase === 'crawling' || source.phase === 'embedding').length;
        header.setContent(
            ` {magenta-fg}{bold}◆ kra-docs{/bold}{/magenta-fg}` +
            `   {cyan-fg}pid{/cyan-fg} {white-fg}${currentSnapshot.coordinatorPid}{/white-fg}` +
            `   {cyan-fg}state{/cyan-fg} ${alive ? '{green-fg}running{/green-fg}' : '{red-fg}stopped{/red-fg}'}` +
            `   {cyan-fg}sources{/cyan-fg} {white-fg}${currentSources.length}{/white-fg}` +
            `   {cyan-fg}active{/cyan-fg} {yellow-fg}${active}{/yellow-fg}`,
        );
        renderPanels();
        screen.render();
    };

    list.on('select item', (_item: blessed.Widgets.BlessedElement, index: number) => {
        selectedAlias = currentSources[index]?.alias ?? null;
        renderPanels();
        screen.render();
    });

    attachVerticalNavigation(list, {
        moveBy: (delta) => {
            const count = Math.max(1, currentSources.length || 1);
            const current = (list as unknown as { selected?: number }).selected ?? 0;
            const next = Math.abs(delta) === 1
                ? (current + delta + count) % count
                : Math.max(0, Math.min(count - 1, current + delta));
            list.select(next);
            selectedAlias = currentSources[next]?.alias ?? null;
            renderPanels();
            screen.render();
        },
        top: () => { list.select(0); selectedAlias = currentSources[0]?.alias ?? null; renderPanels(); screen.render(); },
        bottom: () => {
            const last = Math.max(0, (currentSources.length > 0 ? currentSources.length : 1) - 1);
            list.select(last);
            selectedAlias = currentSources[last]?.alias ?? null;
            renderPanels();
            screen.render();
        },
    });
    attachFocusCycleKeys(screen, ring);

    const tick = setInterval(() => { void refresh(); }, 500);
    screen.key(['q', 'escape', 'C-c'], () => {
        clearInterval(tick);
        try { screen.destroy(); } catch { /* noop */ }
    });
    screen.key(['s'], async () => {
        try {
            const client = createIPCClient(IPCsockets.DocsCoordinatorSocket);
            await client.emit(JSON.stringify({ type: 'shutdown-request' }));
            pushEvents(['{yellow-fg}sent shutdown-request{/yellow-fg}']);
            screen.render();
        } catch (err) {
            pushEvents([`{red-fg}stop failed:{/red-fg} ${escTag(err instanceof Error ? err.message : String(err))}`]);
            screen.render();
        }
    });

    await refresh();
    list.focus();
    screen.render();
    await awaitScreenDestroy(screen);
}