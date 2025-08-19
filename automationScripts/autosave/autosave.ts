import 'module-alias/register';
import { nvimSessionsPath } from '@/filePaths';
import { createIPCServer, IPCServer } from '../../eventSystem/ipc';
import { createLockFile, deleteLockFile, lockFileExist, LockFiles } from '../../eventSystem/lockFiles';
import * as nvim from 'neovim';
import fs from 'fs/promises';
import { loadSettings } from '@/utils/common';
import { Settings } from '@/types/settingsTypes';
import { quickSave } from '@/tmux';

let saveTimer: NodeJS.Timeout | undefined;
let server: IPCServer | undefined;
let settings: Settings | undefined = undefined;
let nvimSessions: {
    [key: string]: {
        socket: string,
        leave: boolean,
    }
} = {}

async function resetSaveTimer(timeout: number = undefined!) {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        await deleteLockFile(LockFiles.AutoSaveInProgress);
        process.exit(0);
    }

    if (saveTimer) {
        clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(async () => {
        const saveFileName = settings!.autosave.currentSession;

        try {
            for (const job of Object.keys(nvimSessions)) {
                const neovimEvent = nvimSessions[job];
                const nvimSessionFileName = `${job}.vim`

                if (neovimEvent.leave) {
                    try {
                        await fs.unlink(`${nvimSessionsPath}/${saveFileName}/${nvimSessionFileName}`)
                    } catch { /* file might not exit if closed an unsaved neovim, so ignore error */ };
                } else {

                    const socket = neovimEvent.socket;

                    const neovim = nvim.attach({ socket })
                        .on('error', () => console.log('error'))
                        .on('disconnect', () => console.log('neovim disconnected'));

                    try { await fs.readdir(`${nvimSessionsPath}/${saveFileName}`) } catch { await fs.mkdir(`${nvimSessionsPath}/${saveFileName}`) }

                    await neovim.command(`mksession! ${nvimSessionsPath}/${saveFileName}/${nvimSessionFileName}`);
                    await neovim.command(`echo 'kra workflow autosaved : ${nvimSessionsPath}/${saveFileName}/${nvimSessionFileName}'`);
                }
            }

            await quickSave(saveFileName);
        } catch (error) {
            console.log(error);
        } finally {
            await deleteLockFile(LockFiles.AutoSaveInProgress);
            server?.close();
            process.exit(0);
        }
    }, timeout || settings!.autosave.timeoutMs);
}

function trackSession(event: string): void {
    const splitEvent = event.split(":")
    const sessionKey = splitEvent.slice(1, 4).join("_");
    const neovimEvent = splitEvent[4];
    const socket = splitEvent[5];

    nvimSessions[sessionKey] = {
        socket,
        leave: neovimEvent === "VimLeave",
    }

}

async function main(): Promise<void> {
    try {
        const server = createIPCServer('/tmp/autosave.sock');

        await server.addListener(async (event) => {
            if (event === 'flush-autosave') {
                resetSaveTimer(0);

                return;
            }

            console.log(event);

            if (event.startsWith('neovim')) {
                trackSession(event);
            }

            resetSaveTimer();
        });

        settings = await loadSettings();

        if (!settings) {
            throw new Error('Could not load settings for autosave, please update settings file, use settings.yaml.example');
        }

        await createLockFile(LockFiles.AutoSaveInProgress);
        resetSaveTimer();
    } catch (error) {
        console.log(error);
    }
}

main().then((_res) => console.log('done'));
