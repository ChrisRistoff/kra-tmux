import * as generalUI from '@/UI/generalUI';
import { singleSessionFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions } from '@/tmux/utils/sessionUtils';
import * as tmux from '@/tmux/utils/common';
import { createLockFile, LockFiles } from '@/../eventSystem/lockFiles';
import {
    listSavedNames,
    readSavedFile,
    savedFileExists,
} from '@/tmux/utils/savedSessionsIO';
import {
    createBaseSessions,
    executeTmuxScript,
    generateRespawnScript,
} from '@/tmux/utils/sessionRespawn';

interface CollisionDecision {
    targetName: string;
    overwrite: boolean;
    cancel: boolean;
}

async function resolveCollision(
    desiredName: string,
    runningSessionNames: string[],
): Promise<CollisionDecision> {
    if (!runningSessionNames.includes(desiredName)) {
        return { targetName: desiredName, overwrite: false, cancel: false };
    }

    let candidate = desiredName;

    while (runningSessionNames.includes(candidate)) {
        const choice = (await generalUI.searchAndSelect({
            itemsArray: ['rename', 'overwrite', 'cancel'],
            prompt: `Session "${candidate}" already exists. (rename / overwrite / cancel): `,
        }) || 'cancel').trim().toLowerCase();

        if (choice === 'overwrite') {
            return { targetName: candidate, overwrite: true, cancel: false };
        }

        if (choice === 'rename') {
            const next = (await generalUI.askUserForInput('New session name: ')).trim();

            if (!next) {
                return { targetName: candidate, overwrite: false, cancel: true };
            }

            candidate = next;

            continue;
        }

        return { targetName: candidate, overwrite: false, cancel: true };
    }

    return { targetName: candidate, overwrite: false, cancel: false };
}

export async function loadSession(preselectedFileName?: string): Promise<void> {
    await createLockFile(LockFiles.LoadInProgress);

    try {
        const itemsArray = await listSavedNames(singleSessionFilesFolder);

        if (itemsArray.length === 0) {
            console.log('No saved sessions found.');

            return;
        }

        const fileName = preselectedFileName ?? await generalUI.searchSelectAndReturnFromArray({
            itemsArray,
            prompt: 'Select a session to load',
            header: `${itemsArray.length} saved single-session file(s)`,
            details: async (name) => {
                try {
                    const data = await readSavedFile(singleSessionFilesFolder, name);
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

        if (!fileName || !(await savedFileExists(singleSessionFilesFolder, fileName))) {
            console.log('Load cancelled.');

            return;
        }

        const savedData = await readSavedFile(singleSessionFilesFolder, fileName);
        const savedSessionNames = Object.keys(savedData);

        if (savedSessionNames.length !== 1) {
            console.warn(
                `Expected exactly 1 session in single-session save, found ${savedSessionNames.length}. ` +
                'Loading the first one only.',
            );
        }

        const originalName = savedSessionNames[0];

        if (!originalName) {
            console.error('Saved file has no sessions.');

            return;
        }

        const currentSessions = await getCurrentSessions();
        const runningNames = Object.keys(currentSessions);

        const decision = await resolveCollision(originalName, runningNames);

        if (decision.cancel) {
            console.log('Load cancelled.');

            return;
        }

        const targetName = decision.targetName;

        const dataForRespawn: TmuxSessions = {
            [targetName]: savedData[originalName],
        };

        const sessionResults = await createBaseSessions(
            [targetName],
            { destroyExisting: decision.overwrite },
        );
        const scriptLines = generateRespawnScript(sessionResults, dataForRespawn, fileName);
        await executeTmuxScript(scriptLines);

        await tmux.sourceTmuxConfig();

        console.log(`Loaded session "${originalName}"${targetName !== originalName ? ` as "${targetName}"` : ''} from ${fileName}`);
    } catch (error) {
        console.error('Load session error:', error);
    }
}
