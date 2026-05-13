import * as fs from 'fs/promises';
import * as generalUI from '@/UI/generalUI';
import { serverFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions, getSavedServerNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/utils/common';
import { saveServerToFile } from '@/tmux/commands/saveServer';
import { createLockFile, LockFiles } from '@/../eventSystem/lockFiles';
import * as utils from '@/utils/common';
import { createBaseSessions, executeTmuxScript, generateRespawnScript } from '@/tmux/utils/sessionRespawn';

/**
 * Main session loading workflow
 * Handles session selection, base session creation, script generation and execution
 */
export async function loadServer(preselectedServerName?: string): Promise<void> {
    await createLockFile(LockFiles.LoadInProgress);

    try {
        const itemsArray = await getSavedServerNames();

        const serverName = preselectedServerName ?? await generalUI.searchSelectAndReturnFromArray({
            itemsArray,
            prompt: 'Select a session to load',
            header: `${itemsArray.length} saved session file(s)`,
            details: async (name) => {
                try {
                    const data = await getServerFromSaved(name);
                    if (!data) return '(empty / unreadable)';
                    const lines: string[] = [`save: ${name}`, ''];
                    let totalWindows = 0;
                    let totalPanes = 0;
                    for (const [sessionName, session] of Object.entries(data)) {
                        const windows = session.windows ?? [];
                        totalWindows += windows.length;
                        lines.push(`\u25c6 ${sessionName}  (${windows.length} window(s))`);
                        for (const w of windows) {
                            const panes = w.panes ?? [];
                            totalPanes += panes.length;
                            lines.push(`  \u25b8 ${w.windowName}  [${panes.length} pane(s)]`);
                            for (const p of panes) {
                                const cmd = p.currentCommand ? ` (${p.currentCommand})` : '';
                                lines.push(`      \u00b7 ${p.currentPath ?? '?'}${cmd}`);
                            }
                        }
                    }
                    lines.splice(1, 0, `${Object.keys(data).length} session(s) \u00b7 ${totalWindows} window(s) \u00b7 ${totalPanes} pane(s)`, '');

                    return lines.join('\n');
                } catch (e: unknown) {
                    return `Failed to read save: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        });

        const savedSessionsData = await getServerFromSaved(serverName);

        if (!savedSessionsData) {
            console.error('No saved sessions found.');

            return;
        }

        const sessionNames = Object.keys(savedSessionsData);

        const sessionResults = await createBaseSessions(sessionNames);
        const scriptLines = generateRespawnScript(sessionResults, savedSessionsData, serverName);
        await executeTmuxScript(scriptLines);

        await tmux.sourceTmuxConfig();

        tmux.updateCurrentSession(serverName).catch((error) => {
            console.error('Error updating current session after load:', error);
        });

        console.log('Sessions loaded successfully');
    } catch (error) {
        console.error('Load session error:', error);
    }
}

/**
 * Retrieves saved tmux sessions from a file for a specified server
 */
export async function getServerFromSaved(serverName: string): Promise<TmuxSessions | null> {
    const filePath = `${serverFilesFolder}/${serverName}`;
    const sessionsObject = await fs.readFile(filePath);

    return JSON.parse(sessionsObject.toString());
}

/**
 * Handles existing tmux server state.
 * Offers to save running sessions and kills them before load.
 */
export async function handleServerIfRunning(): Promise<void> {
    const currentSessions = await getCurrentSessions();
    let shouldSaveCurrentSessions = false;
    let serverIsRunning = false;

    if (Object.keys(currentSessions).length > 0) {
        printSessions(currentSessions);
        serverIsRunning = true;
        shouldSaveCurrentSessions = await generalUI.promptUserYesOrNo(
            'Would you like to save currently running sessions?',
        );
    }

    if (serverIsRunning) {
        if (shouldSaveCurrentSessions) {
            await saveServerToFile();
        }

        await tmux.killServer();
        await utils.sleep(200);
    }
}
