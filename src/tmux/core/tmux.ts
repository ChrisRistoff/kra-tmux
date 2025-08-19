import * as bash from '@/utils/bashHelper';
import { createLockFile, lockFileExist, LockFiles } from '@/../eventSystem/lockFiles';
import { createIPCClient } from '@/../eventSystem/icpClient';
import * as utils from '@/utils/common';
import { execSync } from 'child_process';

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

export async function sourceTmuxConfig(): Promise<void> {
    const sourceTmux = `tmux source ${__dirname}/../../../../tmux-files/.tmux.conf`;
    await bash.execCommand(sourceTmux);
    console.log('Sourced tmux configuration file.');
}

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

export async function detachSession(): Promise<void> {
    try {
        await bash.execCommand('tmux detach');
    } catch (_error) {
        console.log('failed to detach');
    }
}

export async function updateCurrentSession(sessionName: string) {
    const settings = await utils.loadSettings();

    settings.autosave.currentSession = sessionName;

    await utils.saveSettings(settings);
}
