import * as bash from '@/utils/bashHelper';
import { createLockFile, lockFileExist, LockFiles } from '@/../eventSystem/lockFiles';
import { createIPCClient } from '@/../eventSystem/ipc';
import * as utils from '@/utils/common';
import { execSync } from 'child_process';

/**
 * Checks whether a tmux session with the specified name exists
 * @param sessionName - Name of the tmux session to check
 * @returns Boolean indicating if the session exists
 * @throws {Error} If unexpected error occurs during session check
 */
export function checkSessionExists(sessionName: string): boolean {
    try {
        execSync(`tmux has-session -t ${sessionName}`);

        return true;
    } catch (error) {
        if (error instanceof Error && error.message.includes(`can't find session`)) {
            return false;
        }

        throw new Error(`Unexpected error while checking session: ${error}`);
    }
}

/**
 * Sources/reloads the tmux configuration file from the project's tmux-files directory
 * @remarks Uses the bash.execCommand utility to execute tmux source command
 * @throws Will throw an error if the source command fails
 */
export async function sourceTmuxConfig(): Promise<void> {
    const sourceTmux = `tmux source ${__dirname}/../../../../tmux-files/.tmux.conf`;
    await bash.execCommand(sourceTmux);
    console.log('Sourced tmux configuration file.');
}

/**
 * Terminates the tmux server with safety checks
 * @remarks
 * - Creates a server kill lock file to prevent conflicts
 * - Waits for active autosave operations to complete
 * - Emits flush-autosave event if autosave is in progress
 * - Continuously checks for autosave completion before killing server
 * - Handles case where no server is running
 */
export async function killServer(): Promise<void> {
    await createLockFile(LockFiles.ServerKillInProgress);

    try {
        if (await lockFileExist(LockFiles.AutoSaveInProgress)) {
            const client = createIPCClient('/tmp/autosave.sock');

            await client.emit('flush-autosave');
        }

        while (await lockFileExist(LockFiles.AutoSaveInProgress)) {
            console.log("Autosaving completing before exit");

            await utils.sleep(500);
        }

        await bash.execCommand('tmux kill-server');
    } catch (_error) {
        console.log('No Server Running');
    }
}

/**
 * Updates application settings with the current active session name
 * @param sessionName - Name of the session to set as current in settings
 * @remarks Loads existing settings, modifies currentSession property, and saves
 */
export async function updateCurrentSession(sessionName: string) {
    const settings = await utils.loadSettings();

    settings.autosave.currentSession = sessionName;

    await utils.saveSettings(settings);
}
