import * as fs from 'fs/promises';
import * as utils from '@/utils/common';
import * as generalUI from '@/UI/generalUI';
import { nvimSessionsPath, sessionFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions, getSavedSessionsNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/core/tmux';
import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import { createLockFile, deleteLockFile, LockFiles } from '@/../eventSystem/lockFiles'
import { cpus } from 'os';
import * as bash from '@/utils/bashHelper';

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

// Remove worker-related imports and interfaces
interface Window {
    windowName: string;
    layout: string;
    panes: any[];
}

interface SessionResult {
    sessionName: string;
    success: boolean;
    windows: Window[];
    error?: string;
}

// Direct session creation function (replaces loadSessionWorker)
const createSession = async (
    sessionName: string,
    savedData: any
): Promise<SessionResult> => {
    try {
        const sessionConfig = savedData.sessions[sessionName];

        // Create base session with explicit shell
        const shell = process.env.SHELL || '/bin/bash';
        await bash.execCommand(`SHELL=${shell} tmux new-session -d -s ${sessionName} -c ~/`);

        return {
            sessionName,
            success: true,
            windows: sessionConfig.windows
        };
    } catch (error) {
        return {
            sessionName,
            success: false,
            windows: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
};

// Direct window processing function (replaces windowWorker)
const processWindow = async (
    sessionName: string,
    windowIndex: number,
    window: Window,
    serverName: string
): Promise<{ success: boolean; error?: string }> => {
    try {
        const commands: string[] = [];

        // Create window if not the first one
        if (windowIndex > 0) {
            commands.push(`tmux new-window -t ${sessionName} -n ${window.windowName} -c ~/`);
        }

        // Create panes
        window.panes.forEach((_: any, paneIndex: number) => {
            if (paneIndex > 0) {
                commands.push(`tmux split-window -t ${sessionName}:${windowIndex} -c ~/`);
            }
        });

        // Setup layout
        commands.push(
            `tmux select-layout -t ${sessionName}:${windowIndex} "${window.layout}" || tmux select-layout -t ${windowIndex} tiled`,
            `tmux select-pane -t ${sessionName}:${windowIndex}.0`
        );

        // Configure panes
        window.panes.forEach((pane: any, paneIndex: number) => {
            const pathCmd = pane.currentPath.split('/').slice(3).join('/');
            commands.push(
                `tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} "cd ${pathCmd}" Enter`
            );

            if (pane.currentCommand === "nvim") {
                const nvimFile = `${nvimSessionsPath}/${serverName}/${sessionName}_${windowIndex}_${paneIndex}.vim`;
                commands.push(
                    `tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} ` +
                    `'test -f "${nvimFile}" && nvim -S "${nvimFile}" || nvim' Enter`
                );
            }
        });

        // Execute all commands as a single batch script for maximum speed
        const scriptContent = commands.join('\n');
        const tempScript = `/tmp/tmux_window_${sessionName}_${windowIndex}.sh`;

        // Write script to temp file and execute it
        await bash.execCommand(`cat > ${tempScript} << 'TMUX_EOF'\n${scriptContent}\nTMUX_EOF`);
        await bash.execCommand(`chmod +x ${tempScript} && ${tempScript} && rm ${tempScript}`);

        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
};

// Alternative ultra-fast approach using tmux source-file
const createMegaScript = async (sessionResults: SessionResult[], savedData: any): Promise<void> => {
    const scriptLines: string[] = [];

    // Add shell fix for tmux 3.5a
    const shell = process.env.SHELL || '/bin/bash';
    scriptLines.push(`set-environment -g SHELL ${shell}`);

    for (const result of sessionResults) {
        if (!result.success) continue;

        for (const [windowIndex, window] of result.windows.entries()) {
            // Create window
            if (windowIndex > 0) {
                scriptLines.push(`new-window -t ${result.sessionName} -n ${window.windowName} -c ~/`);
            }

            // Create panes
            window.panes.forEach((_: any, paneIndex: number) => {
                if (paneIndex > 0) {
                    scriptLines.push(`split-window -t ${result.sessionName}:${windowIndex} -c ~/`);
                }
            });

            // Setup layout
            scriptLines.push(`select-layout -t ${result.sessionName}:${windowIndex} "${window.layout}"`);
            scriptLines.push(`select-pane -t ${result.sessionName}:${windowIndex}.0`);

            // Configure panes
            window.panes.forEach((pane: any, paneIndex: number) => {
                const pathCmd = pane.currentPath.split('/').slice(3).join('/');
                scriptLines.push(
                    `send-keys -t ${result.sessionName}:${windowIndex}.${paneIndex} "cd ${pathCmd}" Enter`
                );

                if (pane.currentCommand === "nvim") {
                    const nvimFile = `${nvimSessionsPath}/${savedData.fileName}/${result.sessionName}_${windowIndex}_${paneIndex}.vim`;
                    scriptLines.push(
                        `send-keys -t ${result.sessionName}:${windowIndex}.${paneIndex} 'test -f "${nvimFile}" && nvim -S "${nvimFile}" || nvim' Enter`
                    );
                }
            });
        }
    }

    // Write and execute mega script
    const megaScript = `/tmp/tmux_mega_script_${Date.now()}.tmux`;
    await bash.execCommand(`cat > ${megaScript} << 'MEGA_EOF'\n${scriptLines.join('\n')}\nMEGA_EOF`);
    await bash.execCommand(`tmux source-file ${megaScript} && rm ${megaScript}`);
};

// Ultra-fast main function
export async function loadSessionUltraFast(): Promise<void> {
    try {
        await createLockFile(LockFiles.LoadInProgress);
        const savedData = await getSessionsFromSaved();

        if (!savedData?.sessions) {
            console.error('No saved sessions found.');
            await deleteLockFile(LockFiles.LoadInProgress);
            return;
        }

        const sessionNames = Object.keys(savedData.sessions);

        // Create all sessions in parallel (just the base sessions)
        const sessionPromises = sessionNames.map(sessionName =>
            createSession(sessionName, savedData)
        );

        const sessionResults = await Promise.all(sessionPromises);

        // Use mega script approach for ultra speed
        await createMegaScript(sessionResults, savedData);

        await tmux.sourceTmuxConfig();
        await deleteLockFile(LockFiles.LoadInProgress);

    } catch (error) {
        console.error('Load session error:', error);
        await deleteLockFile(LockFiles.LoadInProgress);
    }
}
export async function loadSession(): Promise<void> {
    try {
        await createLockFile(LockFiles.LoadInProgress);
        const savedData = await getSessionsFromSaved();

        if (!savedData?.sessions) {
            console.error('No saved sessions found.');
            await deleteLockFile(LockFiles.LoadInProgress);
            return;
        }

        const sessionNames = Object.keys(savedData.sessions);
        const maxConcurrency = Math.min(sessionNames.length, cpus().length);

        // Process sessions with limited concurrency
        const sessionPromises = sessionNames.map(sessionName =>
            createSession(sessionName, savedData)
        );

        // Process sessions in batches
        const sessionResults: SessionResult[] = [];
        for (let i = 0; i < sessionPromises.length; i += maxConcurrency) {
            const batch = sessionPromises.slice(i, i + maxConcurrency);
            const batchResults = await Promise.all(batch);
            sessionResults.push(...batchResults);
        }

        // Process windows for all successful sessions
        const windowPromises: Promise<any>[] = [];

        for (const result of sessionResults) {
            if (result.success) {
                for (const [windowIndex, window] of result.windows.entries()) {
                    windowPromises.push(
                        processWindow(result.sessionName, windowIndex, window, savedData.fileName)
                    );
                }
            } else {
                console.error(`Failed to create session ${result.sessionName}:`, result.error);
            }
        }

        // Process windows with limited concurrency
        const windowMaxConcurrency = Math.min(windowPromises.length, cpus().length);
        for (let i = 0; i < windowPromises.length; i += windowMaxConcurrency) {
            const batch = windowPromises.slice(i, i + windowMaxConcurrency);
            const results = await Promise.all(batch);

            // Log any window processing errors
            results.forEach((result) => {
                if (!result.success) {
                    console.error(`Window processing failed:`, result.error);
                }
            });
        }

        await tmux.sourceTmuxConfig();
        await deleteLockFile(LockFiles.LoadInProgress);

    } catch (error) {
        console.error('Load session error:', error);
        await deleteLockFile(LockFiles.LoadInProgress);
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
