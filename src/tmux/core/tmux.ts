import * as bash from '@/utils/bashHelper';
import { lockFileExist, LockFiles } from '@/../eventSystem/lockFiles';
import { createIPCClient } from '@/../eventSystem/ipc';
import * as utils from '@/utils/common';

export async function checkSessionExists(sessionName: string): Promise<boolean> {
    try {
        await bash.execCommand(`tmux has-session -t ${sessionName}`);

        return true;
    } catch (error) {
        if (error instanceof Error && error.message.includes(`can't find session`)) {
            return false;
        }
        throw new Error(`Unexpected error while checking session: ${error}`);
    }
}

export async function attachToSession(sessionName: string): Promise<void> {
    if (!await checkSessionExists(sessionName)) {
        console.log(`Session does not exist: ${sessionName}`);

        return;
    }

    console.log(`Attaching to tmux session: ${sessionName}`);
    bash.runCommand('tmux', ['attach-session', '-t', sessionName], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, TMUX: '' },
    });
}

export async function sourceTmuxConfig(): Promise<void> {
    const sourceTmux = `tmux source ${__dirname}/../../../../tmux-files/.tmux.conf`;
    await bash.execCommand(sourceTmux);
    console.log('Sourced tmux configuration file.');
}

export async function killServer(): Promise<void> {
    try {
        if (await lockFileExist(LockFiles.AutoSaveInProgress)) {
            const client = createIPCClient('/tmp/autosave.sock');

            await client.ensureConnected();
            await client.emit('interrupt');
        }

        while(await lockFileExist(LockFiles.AutoSaveInProgress)) {
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

export async function createSession(sessionName: string): Promise<void> {
    await bash.execCommand(`tmux new-session -d -s ${sessionName}`);
}

export async function createWindow(windowName: string): Promise<void> {
    await bash.execCommand(`tmux new-window -n ${windowName} -c ~/`);
}

export async function createPane(sessionName: string, windowIndex: number): Promise<void> {
    await bash.execCommand(`tmux split-window -t ${sessionName}:${windowIndex} -c ~/`);
}

export async function setLayout(sessionName: string, windowIndex: number, layout: string): Promise<void> {
    await bash.execCommand(`tmux select-layout -t ${sessionName}:${windowIndex} "${layout}"`);
}

export async function selectPane(sessionName: string, windowIndex: number, paneIndex: number): Promise<void> {
    await bash.execCommand(`tmux select-pane -t ${sessionName}:${windowIndex}.${paneIndex}`);
}

export async function selectWindow(windowIndex: number): Promise<void> {
    await bash.execCommand(`tmux select-window -t ${windowIndex}`);
}

export async function renameWindow(sessionName: string, windowIndex: number, windowName: string): Promise<void> {
    await bash.execCommand(`tmux rename-window -t ${sessionName}:${windowIndex} ${windowName}`);
}
