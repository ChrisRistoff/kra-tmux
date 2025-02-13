import * as bash from '@utils/bashHelper';
import * as utils from '@utils/common';
import * as generalUI from '@UI/generalUI';
import * as fs from 'fs/promises';
import * as nvim from '@utils/neovimHelper';
import { sessionFilesFolder } from '@filePaths';
import { TmuxSessions, Pane } from '@customTypes/sessionTypes';
import { Settings } from '@customTypes/settingsTypes';
import { getCurrentSessions, getSavedSessionsNames } from '@sessions/utils/sessionUtils';
import { printSessions } from '@sessions/commands/printSessions';
import * as tmux from '@sessions/core/tmux';
import { saveSessionsToFile } from '@sessions/commands/saveSessions';

async function getSessionsFromSaved(): Promise<{ sessions: TmuxSessions; fileName: string } | null> {
    const itemsArray = await getSavedSessionsNames();

    const fileName = await generalUI.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: "Select a session to load from the list:",
    });

    if (!fileName) {
        return null;
    }

    const filePath = `${sessionFilesFolder}/${fileName}`;
    const latestSessions = await fs.readFile(filePath);

    return {
        fileName,
        sessions: JSON.parse(latestSessions.toString())
    };
}

async function navigateToFolder(pane: Pane, paneIndex: number): Promise<void> {
    const pathArray = pane.currentPath.split('/');

    await bash.sendKeysToTmuxTargetSession({
        paneIndex: paneIndex,
        command: 'cd'
    });

    for (let i = 3; i < pathArray.length; i++) {
        const folderPath = pathArray[i];
        console.log(`Checking existence of directory: ${folderPath}`);

        try {
            await bash.sendKeysToTmuxTargetSession({
                paneIndex,
                command: `[ -d '${folderPath}' ] && echo 'Directory exists' || (git clone ${pane.gitRepoLink} ${folderPath})`,
            });
            await bash.sendKeysToTmuxTargetSession({
                paneIndex,
                command: `cd ${folderPath} && echo 'Navigated to ${folderPath}'`,
            });
        } catch (error) {
            console.error(`Error while checking or navigating: ${error}`);
        }
    }
}

async function handleWatchCommands(
    settings: Settings,
    windowName: string,
    sessionName: string,
    windowIndex: number
): Promise<void> {
    if (settings.work && windowName === settings.workWindowNameForWatch) {
        await bash.sendKeysToTmuxTargetSession({
            sessionName,
            windowIndex,
            paneIndex: 0,
            command: settings.workCommandForWatch,
        });
    } else if (!settings.work && windowName === settings.personalWindowNameForWatch) {
        await bash.sendKeysToTmuxTargetSession({
            sessionName,
            windowIndex,
            paneIndex: 0,
            command: settings.personalCommandForWatch,
        });
    }
}

async function createTmuxSession(sessionName: string, sessions: TmuxSessions, fileName: string): Promise<void> {
    await tmux.createSession(sessionName);

    for (const [windowIndex, window] of sessions[sessionName].windows.entries()) {
        if (windowIndex > 0) {
            await tmux.createWindow(window.windowName);
        }

        for (const [paneIndex, pane] of window.panes.entries()) {
            if (paneIndex > 0) {
                await tmux.createPane(sessionName, windowIndex);
            }

            await navigateToFolder(pane, paneIndex);

            if (pane.currentCommand === "nvim") {
                await nvim.loadNvimSession(fileName, sessionName, windowIndex, paneIndex);
            }
        }

        await tmux.setLayout(sessionName, windowIndex, window.layout);
        await tmux.selectPane(sessionName, windowIndex, 0);

        const settings: Settings = await utils.loadSettings();
        await handleWatchCommands(settings, window.windowName, sessionName, windowIndex);
    }

    await tmux.selectWindow(0);
    await tmux.renameWindow(sessionName, 0, sessions[sessionName].windows[0].windowName);
}

export async function loadLatestSession(): Promise<void> {
    try {
        const savedData = await getSessionsFromSaved();

        if (!savedData || Object.keys(savedData.sessions).length === 0) {
            console.error('No saved sessions found.');

            return;
        }

        for (const sess of Object.keys(savedData.sessions)) {
            await createTmuxSession(sess, savedData.sessions, savedData.fileName);
        }

        await tmux.sourceTmuxConfig();
        const firstSession = Object.keys(savedData.sessions)[0];
        await tmux.attachToSession(firstSession);
    } catch (error) {
        console.error('Error in loadLatestSession:', error);
    }
}

export async function handleSessionsIfServerIsRunning(): Promise<void> {
    const currentSessions = await getCurrentSessions();
    let shouldSaveCurrentSessions = false;
    let serverIsRunning = false;

    if (Object.keys(currentSessions).length > 0) {
        printSessions(currentSessions);
        serverIsRunning = true;
        shouldSaveCurrentSessions = await generalUI.promptUserYesOrNo(
            'Would you like to save currently running sessions?'
        );
    }

    if (serverIsRunning) {
        if (shouldSaveCurrentSessions) {
            await saveSessionsToFile();
        }
        await tmux.killServer();
        await utils.sleep(200);
    }
}
