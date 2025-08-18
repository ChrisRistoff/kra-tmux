import * as fs from 'fs/promises';
import * as utils from '@/utils/common';
import * as generalUI from '@/UI/generalUI';
import { nvimSessionsPath, sessionFilesFolder } from '@/filePaths';
import { Window, SessionResult, TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions, getSavedSessionsNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/core/tmux';
import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import { createLockFile, LockFiles } from '@/../eventSystem/lockFiles'
import * as bash from '@/utils/bashHelper';

export async function getSessionsFromSaved(serverName: string): Promise<TmuxSessions | null> {
    const filePath = `${sessionFilesFolder}/${serverName}`;
    const sessionsObject = await fs.readFile(filePath);

    return JSON.parse(sessionsObject.toString())
}

/**
 * Creates base tmux sessions with minimal shell initialization
 */
async function createBaseSessions(sessionNames: string[]): Promise<SessionResult[]> {
    const createCommands = sessionNames.map(sessionName =>
        `tmux new-session -d -s "${sessionName}"`
    );

    // execute all session creations in parallel
    const script = createCommands.join(' & ');
    await bash.execCommand(`${script} & wait`);

    return sessionNames.map(sessionName => ({
        sessionName,
        success: true,
        windows: []
    }));
}

/**
 * Generates optimized tmux script using respawn-pane to bypass shell loading
 */
function generateRespawnScript(sessionResults: SessionResult[], savedData: TmuxSessions, serverName: string): string[] {
    const scriptLines: string[] = [];

    for (const result of sessionResults) {
        const sessionConfig = savedData[result.sessionName];

        if (!sessionConfig?.windows) {
            continue;
        }

        sessionConfig.windows.forEach((window: Window, windowIndex: number) => {
            const windowTarget = `${result.sessionName}:${windowIndex}`;

            // create/rename window
            if (windowIndex === 0) {
                scriptLines.push(`rename-window -t ${result.sessionName}:0 "${window.windowName}"`);
            } else {
                scriptLines.push(`new-window -t ${result.sessionName}:${windowIndex} -n "${window.windowName}" -c ~/`);
            }
            // create additional panes
            window.panes.slice(1).forEach(() => {
                scriptLines.push(`split-window -t ${windowTarget} -c ~/`);
            });

            scriptLines.push(`select-layout -t ${windowTarget} "${window.layout}"`);

            window.panes.forEach((pane, paneIndex) => {
                const paneTarget = `${windowTarget}.${paneIndex}`;
                const workingDir = pane.currentPath.split('/').slice(3).join('/') || '~';

                if (pane.currentCommand === "nvim") {
                    const nvimSessionFile = `${nvimSessionsPath}/${serverName}/${result.sessionName}_${windowIndex}_${paneIndex}.vim`;
                    const shell = process.env.SHELL || '/bin/bash';
                    const nvimCommand = `${shell} -c 'cd "${workingDir}" && (if [ -f "${nvimSessionFile}" ]; then nvim -S "${nvimSessionFile}"; else nvim; fi); exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${nvimCommand}"`);
                } else {
                    const shell = process.env.SHELL || '/bin/bash';
                    const shellCommand = `/bin/bash -c 'cd "${workingDir}" && exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${shellCommand}"`);
                }
            });

            scriptLines.push(`select-pane -t ${windowTarget}.0`);
        });

        result.windows = sessionConfig.windows;
    }

    return scriptLines;
}

/**
 * Executes tmux script with window indexing safeguards
 */
async function executeTmuxScript(scriptLines: string[]): Promise<void> {
    const timestamp = Date.now();
    const scriptPath = `/tmp/tmux_ultra_script_${timestamp}.tmux`;

    // add commands to ensure consistent window indexing
    const safeguardedScript = [
        '# Ensure base-index is 0 for consistent window numbering',
        'set-option -g base-index 0',
        'set-option -g pane-base-index 0',
        '# Disable automatic window renumbering during script execution',
        'set-option -g renumber-windows off',
        '',
        ...scriptLines,
        '',
        '# Re-enable renumber-windows if it was previously enabled',
        'set-option -g renumber-windows on'
    ];

    const scriptContent = safeguardedScript.join('\n');
    await bash.execCommand(`cat > "${scriptPath}" << 'SCRIPT_EOF'
${scriptContent}
SCRIPT_EOF`);

    try {
        await bash.execCommand(`tmux source-file "${scriptPath}"`);
    } finally {
        await fs.rm(scriptPath);
    }
}

export async function loadSession(): Promise<void> {
    await createLockFile(LockFiles.LoadInProgress);

    try {
        const itemsArray = await getSavedSessionsNames();

        const serverName = await generalUI.searchSelectAndReturnFromArray({
            itemsArray,
            prompt: "Select a session to load from the list:",
        })

        const savedSessionsData = await getSessionsFromSaved(serverName);

        if (!savedSessionsData) {
            console.error('No saved sessions found.');
            return;
        }

        const sessionNames = Object.keys(savedSessionsData);

        const sessionResults = await createBaseSessions(sessionNames);
        const scriptLines = generateRespawnScript(sessionResults, savedSessionsData, serverName);
        await executeTmuxScript(scriptLines);

        await tmux.sourceTmuxConfig();

        tmux.updateCurrentSession(serverName);

        console.log('Sessions loaded successfully');
    } catch (error) {
        console.error('Load session error:', error);
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
