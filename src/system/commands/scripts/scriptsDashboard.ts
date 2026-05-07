import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { systemScriptsPath } from '@/filePaths';
import { execCommand } from '@/utils/bashHelper';
import { filterGitKeep } from '@/utils/common';
import {
    createListDetailDashboard,
    escTag,
    modalConfirm,
    modalText,
} from '@/UI/dashboard';
import { runInherit } from '@/UI/dashboard/screen';
import { makeExecutableIfNoPermissions } from '@/system/utils/fileUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScriptEntry {
    name: string;
    absPath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadScripts(): Promise<ScriptEntry[]> {
    try {
        const names = filterGitKeep(await fs.readdir(systemScriptsPath));
        return names.map((name) => ({ name, absPath: path.join(systemScriptsPath, name) }));
    } catch {
        return [];
    }
}

async function loadPreview(absPath: string): Promise<string> {
    try {
        const { stdout } = await execCommand(`head -n 100 ${JSON.stringify(absPath)} 2>/dev/null`);
        if (!stdout.trim()) return '{gray-fg}(empty script){/gray-fg}';
        return escTag(stdout);
    } catch {
        return '{red-fg}(could not read script){/red-fg}';
    }
}

async function loadMeta(entry: ScriptEntry): Promise<string> {
    try {
        const [lsOut, wcOut] = await Promise.all([
            execCommand(`ls -la ${JSON.stringify(entry.absPath)} 2>/dev/null`).then((r) => r.stdout.trim()),
            execCommand(`wc -l ${JSON.stringify(entry.absPath)} 2>/dev/null`).then((r) => r.stdout.trim()),
        ]);
        const lineCount = wcOut.split(/\s+/)[0] ?? '?';
        const modified = lsOut.split(/\s+/).slice(5, 8).join(' ') || '?';
        const size = lsOut.split(/\s+/)[4] ?? '?';
        return (
            `{cyan-fg}name    {/cyan-fg}${escTag(entry.name)}\n` +
            `{cyan-fg}path    {/cyan-fg}${escTag(entry.absPath)}\n` +
            `{cyan-fg}size    {/cyan-fg}${size} bytes\n` +
            `{cyan-fg}lines   {/cyan-fg}${lineCount}\n` +
            `{cyan-fg}modified{/cyan-fg}${modified}\n\n` +
            `{white-fg}${escTag(lsOut)}{/white-fg}`
        );
    } catch {
        return `{cyan-fg}name{/cyan-fg}  ${escTag(entry.name)}`;
    }
}

function renderRow(entry: ScriptEntry, isSelected: boolean): string {
    const marker = isSelected ? '{yellow-fg}▶{/yellow-fg} ' : '  ';
    return `${marker}{green-fg}📜{/green-fg} ${escTag(entry.name)}`;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function openScriptsDashboard(): Promise<void> {
    let scripts = await loadScripts();
    const previewCache = new Map<string, string>();
    const metaCache = new Map<string, string>();

    await createListDetailDashboard<ScriptEntry>({
        title: 'kra-scripts',
        initialRows: scripts,
        rowKey: (e) => e.absPath,
        renderListItem: (e, _i, isSelected) => renderRow(e, isSelected),
        listLabel: 'scripts',
        listFocusName: 'scripts',
        listWidth: '42%',
        headerContent: () => {
            const countTag = `{cyan-fg}scripts{/cyan-fg} {yellow-fg}${scripts.length}{/yellow-fg}`;
            return ` ${countTag}`;
        },
        filter: {
            label: 'filter',
            mode: 'live',
            match: (e, q) => e.name.toLowerCase().includes(q.toLowerCase()),
        },
        detailPanels: [
            {
                label: 'preview',
                focusName: 'preview',
                paint: async (entry) => {
                    const cached = previewCache.get(entry.absPath);
                    if (cached !== undefined) return cached;
                    const v = await loadPreview(entry.absPath);
                    previewCache.set(entry.absPath, v);
                    return v;
                },
            },
            {
                label: 'info',
                focusName: 'info',
                paint: async (entry) => {
                    const cached = metaCache.get(entry.absPath);
                    if (cached !== undefined) return cached;
                    const v = await loadMeta(entry);
                    metaCache.set(entry.absPath, v);
                    return v;
                },
            },
            {
                label: 'output',
                focusName: 'output',
                initialContent: '{gray-fg}(no run yet — press enter to run){/gray-fg}',
                // selection changes don't regenerate this panel; actions write into it
                paint: () => null,
            },
        ],
        keymapText: () =>
            `{cyan-fg}j/k{/cyan-fg} nav   {cyan-fg}/{/cyan-fg} filter   ` +
            `{cyan-fg}enter{/cyan-fg} run   {cyan-fg}x{/cyan-fg} interactive   ` +
            `{cyan-fg}e{/cyan-fg} edit   {cyan-fg}n{/cyan-fg} new   ` +
            `{cyan-fg}D{/cyan-fg} delete   {cyan-fg}y{/cyan-fg} yank path   ` +
            `{cyan-fg}r{/cyan-fg} reload   ` +
            `{cyan-fg}Tab{/cyan-fg} focus   {cyan-fg}q{/cyan-fg} quit`,
        actions: [
            {
                keys: 'enter',
                handler: async (entry, api) => {
                    if (!entry) return;
                    await makeExecutableIfNoPermissions(entry.absPath);
                    const outputPanel = api.shell.detailPanels[2];
                    outputPanel.setContent(`{gray-fg}Running {/gray-fg}{yellow-fg}${escTag(entry.name)}{/yellow-fg}{gray-fg}…{/gray-fg}`);
                    outputPanel.focus();
                    api.screen.render();
                    try {
                        const { stdout, stderr } = await execCommand(`sh ${JSON.stringify(entry.absPath)} 2>&1`);
                        const combined = (stdout + stderr).trim();
                        outputPanel.setContent(
                            `{cyan-fg}▶ ${escTag(entry.name)}{/cyan-fg}\n\n` +
                            (combined ? escTag(combined) : '{gray-fg}(no output){/gray-fg}'),
                        );
                        outputPanel.setScrollPerc(100);
                    } catch (err) {
                        outputPanel.setContent(
                            `{red-fg}Error running ${escTag(entry.name)}:{/red-fg}\n\n` +
                            escTag((err as Error).message),
                        );
                    }
                    api.screen.render();
                },
            },
            {
                keys: 'x',
                handler: async (entry, api) => {
                    if (!entry) return;
                    await makeExecutableIfNoPermissions(entry.absPath);
                    const outputPanel = api.shell.detailPanels[2];
                    outputPanel.setContent('{gray-fg}(interactive run — output not captured){/gray-fg}');
                    await runInherit('sh', [entry.absPath], api.screen);
                    api.screen.render();
                },
            },
            {
                keys: 'e',
                handler: async (entry, api) => {
                    if (!entry) return;
                    await runInherit('nvim', [entry.absPath], api.screen);
                    previewCache.delete(entry.absPath);
                    metaCache.delete(entry.absPath);
                    api.repaintDetails();
                },
            },
            {
                keys: 'n',
                handler: async (_entry, api) => {
                    const { value: rawName } = await modalText(api.screen, 'New script name (e.g. deploy.sh)', '', {
                        hint: 'enter create · esc cancel',
                    });
                    const name = rawName?.trim();
                    if (!name) return;
                    const safeName = name.endsWith('.sh') ? name : `${name}.sh`;
                    const newPath = path.join(systemScriptsPath, safeName);
                    try {
                        await fs.writeFile(newPath, '#!/bin/bash\n\n', { flag: 'wx' });
                        await execCommand(`chmod +x ${JSON.stringify(newPath)}`);
                    } catch {
                        // file may already exist — just open it
                    }
                    await runInherit('nvim', [newPath], api.screen);
                    scripts = await loadScripts();
                    api.setRows(scripts, { preserveKey: newPath });
                    api.refreshHeader();
                },
            },
            {
                keys: ['D', 'S-d'],
                handler: async (entry, api) => {
                    if (!entry) return;
                    const ok = await modalConfirm(api.screen, 'Delete script', `Delete ${entry.name}?`);
                    if (!ok) return;
                    try {
                        await fs.unlink(entry.absPath);
                        previewCache.delete(entry.absPath);
                        metaCache.delete(entry.absPath);
                        scripts = scripts.filter((e) => e.absPath !== entry.absPath);
                        api.setRows(scripts);
                        api.refreshHeader();
                    } catch (e) {
                        api.flashHeader(`Error: ${(e as Error).message}`);
                    }
                },
            },
            {
                keys: 'y',
                handler: (entry, api) => {
                    if (!entry) return;
                    const cmd = os.platform() === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
                    execCommand(`echo ${JSON.stringify(entry.absPath)} | ${cmd}`).catch(() => null);
                    api.flashHeader(`Copied: ${entry.name}`);
                },
            },
            {
                keys: 'r',
                handler: async (_entry, api) => {
                    previewCache.clear();
                    metaCache.clear();
                    scripts = await loadScripts();
                    api.setRows(scripts);
                    api.refreshHeader();
                    api.repaintDetails();
                },
            },
        ],
    });
}
