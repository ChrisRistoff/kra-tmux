import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { systemScriptsPath } from '@/filePaths';
import { execCommand } from '@/utils/bashHelper';
import { filterGitKeep } from '@/utils/common';
import {
    createListDetailDashboard,
    escTag,
    highlightCode,
    modalConfirm,
    modalText,
    sanitizeForBlessed,
    theme,
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
        if (!stdout.trim()) return theme.dim('(empty script)');
        return escTag(highlightCode(sanitizeForBlessed(stdout), absPath));
    } catch {
        return theme.err('(could not read script)');
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
            `${theme.label('name    ')}${theme.value(escTag(entry.name))}\n` +
            `${theme.label('path    ')}${theme.path(escTag(entry.absPath))}\n` +
            `${theme.label('size    ')}${theme.size(`${size} bytes`)}\n` +
            `${theme.label('lines   ')}${theme.count(lineCount)}\n` +
            `${theme.label('modified')} ${theme.date(modified)}\n\n` +
            `${theme.dim(escTag(lsOut))}`
        );
    } catch {
        return `${theme.label('name')}  ${theme.value(escTag(entry.name))}`;
    }
}

function renderRow(entry: ScriptEntry, isSelected: boolean): string {
    const marker = isSelected ? `${theme.selected('▶')} ` : '  ';
    return `${marker}${theme.success('📜')} ${theme.value(escTag(entry.name))}`;
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
        headerContent: () => ` ${theme.label('scripts')} ${theme.count(scripts.length)}`,
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
                initialContent: theme.dim('(no run yet — press enter to run)'),
                // selection changes don't regenerate this panel; actions write into it
                paint: () => null,
            },
        ],
        keymapText: () =>
            `${theme.key('j/k')} nav   ${theme.key('/')} filter   ` +
            `${theme.key('enter')} run   ${theme.key('x')} interactive   ` +
            `${theme.key('e')} edit   ${theme.key('n')} new   ` +
            `${theme.key('D')} delete   ${theme.key('y')} yank path   ` +
            `${theme.key('r')} reload   ` +
            `${theme.key('Tab')} focus   ${theme.key('q')} quit`,
        actions: [
            {
                keys: 'enter',
                handler: async (entry, api) => {
                    if (!entry) return;
                    await makeExecutableIfNoPermissions(entry.absPath);
                    const outputPanel = api.shell.detailPanels[2];
                    outputPanel.setContent(`${theme.dim('Running ')}${theme.warn(escTag(entry.name))}${theme.dim('…')}`);
                    outputPanel.focus();
                    api.screen.render();
                    try {
                        const { stdout, stderr } = await execCommand(`sh ${JSON.stringify(entry.absPath)} 2>&1`);
                        const combined = (stdout + stderr).trim();
                        outputPanel.setContent(
                            `${theme.title(`▶ ${escTag(entry.name)}`)}\n\n` +
                            (combined ? escTag(combined) : theme.dim('(no output)')),
                        );
                        outputPanel.setScrollPerc(100);
                    } catch (err) {
                        outputPanel.setContent(
                            `${theme.err(`Error running ${escTag(entry.name)}:`)}\n\n` +
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
                    outputPanel.setContent(theme.dim('(interactive run — output not captured)'));
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
