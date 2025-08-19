import * as fs from 'fs/promises';
import * as utils from '@/utils/common';
import * as generalUI from '@/UI/generalUI';
import { nvimSessionsPath, sessionFilesFolder } from '@/filePaths';
import { Window, SessionResult, TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions, getSavedSessionsNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/utils/common';
import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import { createLockFile, LockFiles } from '@/../eventSystem/lockFiles';
import * as bash from '@/utils/bashHelper';

/**
 * Main session loading workflow
 * Handles session selection, base session creation, script generation and execution
 */
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

/**
 * Retrieves saved tmux sessions from a file for a specified server
 * @param serverName - Name of the server to load sessions from
 * @returns Parsed tmux session data or null if not found
 */
export async function getSessionsFromSaved(serverName: string): Promise<TmuxSessions | null> {
    const filePath = `${sessionFilesFolder}/${serverName}`;
    const sessionsObject = await fs.readFile(filePath);

    return JSON.parse(sessionsObject.toString())
}

/**
 * Generates performant tmux script using respawn-pane to bypass shell loading
 * Creates window/pane structure and configures commands/working directories
 * @param sessionResults - Session creation results from base session setup
 * @param savedData - Saved tmux session configuration data
 * @param serverName - Name of the server being restored
 * @returns Array of tmux commands to execute for session restoration
 */
function generateRespawnScript(sessionResults: SessionResult[], savedData: TmuxSessions, serverName: string): string[] {
    const scriptLines: string[] = [];

    for (const result of sessionResults) {
        const sessionConfig = savedData[result.sessionName];

        if (!sessionConfig?.windows) {
            continue;
        }

        // sort windows by their saved index to ensure proper order
        const sortedWindows = [...sessionConfig.windows].sort((a, b) => {
            // if windows have an index property, use it; otherwise use array index
            const aIndex = (a as any).windowIndex ?? sessionConfig.windows.indexOf(a);
            const bIndex = (b as any).windowIndex ?? sessionConfig.windows.indexOf(b);
            return aIndex - bIndex;
        });

        console.log(`Processing ${sortedWindows.length} windows for session ${result.sessionName}`);

        sortedWindows.forEach((window: Window, arrayIndex: number) => {
            // skip invalid window configurations
            if (!validateWindowConfig(window)) {
                console.warn(`Skipping invalid window config: ${window.windowName}`);
                return;
            }

            // use the array index for tmux window targeting (0, 1, 2, 3, 4...)
            const tmuxWindowIndex = arrayIndex;
            const windowTarget = `${result.sessionName}:${tmuxWindowIndex}`;

            console.log(`Creating window ${tmuxWindowIndex}: ${window.windowName} with ${window.panes.length} panes`);

            // handle window creation/renaming
            if (tmuxWindowIndex === 0) {
                // Window 0 should already exist from session creation
                scriptLines.push(`select-window -t ${result.sessionName}:0`);
                scriptLines.push(`rename-window -t ${result.sessionName}:0 "${window.windowName}"`);
            } else {
                // create new windows with explicit index
                scriptLines.push(`new-window -t ${result.sessionName}:${tmuxWindowIndex} -n "${window.windowName}" -c ~/`);
            }

            // only create additional panes if we have more than 1 pane
            if (window.panes.length > 1) {
                // Create additional panes (starting from index 1 since pane 0 already exists)
                for (let i = 1; i < window.panes.length; i++) {
                    scriptLines.push(`split-window -t ${windowTarget} -c ~/`);
                }

                // Only apply layout if we have multiple panes AND layout exists
                if (window.layout) {
                    scriptLines.push(`select-layout -t ${windowTarget} "${window.layout}"`);
                }
            }

            // setup each pane with its command and working directory
            window.panes.forEach((pane, paneIndex) => {
                const paneTarget = `${windowTarget}.${paneIndex}`;
                const workingDir = pane.currentPath?.split('/').slice(3).join('/') || '~';

                if (pane.currentCommand === "nvim") {
                    const nvimSessionFile = `${nvimSessionsPath}/${serverName}/${result.sessionName}_${tmuxWindowIndex}_${paneIndex}.vim`;
                    const shell = process.env.SHELL || '/bin/bash';
                    const nvimCommand = `${shell} -c 'cd "${workingDir}" && (if [ -f "${nvimSessionFile}" ]; then nvim -S "${nvimSessionFile}"; else nvim; fi); exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${nvimCommand}"`);
                } else {
                    const shell = process.env.SHELL || '/bin/bash';
                    const shellCommand = `/bin/bash -c 'cd "${workingDir}" && exec ${shell}'`;
                    scriptLines.push(`respawn-pane -t ${paneTarget} -k "${shellCommand}"`);
                }
            });

            // select the first pane in the window
            scriptLines.push(`select-pane -t ${windowTarget}.0`);
        });

        // update result with the processed windows
        result.windows = sortedWindows;
    }

    return scriptLines;
}

/**
 * Validates window configuration to ensure layout matches pane count
 * @param window - Window configuration to validate
 * @returns True if window configuration is valid, false otherwise
 */
function validateWindowConfig(window: Window): boolean {
    const paneCount = window.panes?.length || 0;

    // must have at least one pane
    if (!paneCount) {
        console.warn(`Window ${window.windowName} has no panes`);
        return false;
    }

    // if one pane, any layout should work
    if (paneCount === 1) return true;

    // For multiple panes, layout should exist
    if (!window.layout) {
        console.warn(`Window ${window.windowName} has ${paneCount} panes but no layout`);
        return false;
    }

    return true;
}

/**
 * Creates base tmux sessions with minimal shell initialization
 * Kills existing sessions and creates fresh ones with basic configuration
 * @param sessionNames - Array of session names to create
 * @returns Array of session creation results with success status
 */
async function createBaseSessions(sessionNames: string[]): Promise<SessionResult[]> {
    console.log(`Creating ${sessionNames.length} base sessions:`, sessionNames);

    // kill any existing sessions
    for (const sessionName of sessionNames) {
        try {
            await bash.execCommand(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`);
            console.log(`Cleaned up existing session: ${sessionName}`);
        } catch (error) {
            // ignore
        }
    }

    const results: SessionResult[] = [];

    // create sessions one by one for better error handling, verification and consistency with saves
    for (const sessionName of sessionNames) {
        try {
            // hcreate new session
            await bash.execCommand(`tmux new-session -d -s "${sessionName}" -c ~/`);

            // verify session was created
            await bash.execCommand(`tmux has-session -t "${sessionName}"`);

            // list windows to verify structure
            const windowList = await bash.execCommand(`tmux list-windows -t "${sessionName}" -F "#{window_index}:#{window_name}"`);
            console.log(`Session ${sessionName} created with windows:`, windowList.stdout.trim());

            results.push({
                sessionName,
                success: true,
                windows: []
            });

        } catch (error) {
            console.error(`Failed to create session ${sessionName}:`, error);
            results.push({
                sessionName,
                success: false,
                windows: []
            });
        }
    }

    console.log(`Successfully created ${results.filter(r => r.success).length}/${sessionNames.length} sessions`);
    return results;
}

/**
 * Executes tmux script with window indexing safeguards
 * Creates temporary script file with base-index configuration and executes it
 * @param scriptLines - Array of tmux commands to execute
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

/**
 * Handles existing tmux server state
 * Offers to save running sessions and kills them before load
 */
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
