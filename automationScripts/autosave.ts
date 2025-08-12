import * as bash from '../src/utils/bashHelper';
import { createIPCServer, IPCServer } from '../eventSystem/ipc';
import { createLockFile, deleteLockFile, lockFileExist, LockFiles } from '../eventSystem/lockFiles';
import * as nvim from 'neovim';
import os from 'os';
import path from 'path';

const scheduledJobs = new Set<string>();
let saveTimer: NodeJS.Timeout | undefined;
let neovim: nvim.Neovim | undefined;
let server: IPCServer | undefined;

const homeDir = os.homedir();
const projectPath = 'programming/kra-tmux/'
export const nvimSessionsPath = path.join(homeDir, projectPath, 'tmux-files/nvim-sessions');

async function resetSaveTimer() {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        await deleteLockFile(LockFiles.AutoSaveInProgress);
        process.exit(0);
    }

    if (saveTimer) {
        clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(async () => {
        if (scheduledJobs.size > 0) {
            try {
                if (scheduledJobs.has('tmux')) {
                    await bash.execCommand('kra tmux quicksave');
                }

                scheduledJobs.forEach((job) => {
                    if (job.startsWith('neovim')) {
                        const splitJob = job.split(':');
                        const folderName = 'auto-save-wtf';
                        const nvimSessionFileName = `${splitJob[1]}_${splitJob[2]}_${splitJob[3]}.vim`

                        // if event vim leave, delete session

                        neovim?.command(`mksession! ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`);
                        neovim?.command(`echo 'session autosaved : ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}'`);
                    }
                })
            } catch (error) {
                console.log(error, 'INSIDE TIMER');
            } finally {
                console.log('finally in timer');
                await deleteLockFile(LockFiles.AutoSaveInProgress);
                server?.close();
                process.exit(0);
            }
        }
    }, 20000);
}

async function main(): Promise<void> {
    try {
        const server = createIPCServer('/tmp/autosave.sock');

        await server.addListener(event => {
            console.log(event);
            const splitEvent = event.split(':');

            if (typeof event === 'string' && event.startsWith('neovim:') && !scheduledJobs.has(event)) {
                const socket = splitEvent[splitEvent.length - 1];

                console.log(splitEvent[splitEvent.length - 2])

                if (splitEvent[splitEvent.length - 2] !== 'VimLeave') {
                    neovim = nvim.attach({ socket })
                        .on('error', () => console.log('error'));
                }
            }

            scheduledJobs.add(event);
            resetSaveTimer();
        });

        await createLockFile(LockFiles.AutoSaveInProgress);
        await resetSaveTimer();
    } catch (error) {
        console.log(error, 'INSIDE MAIN');
    }
}

main().then((_res) => console.log('wooop'));
