import 'module-alias/register';
import { nvimSessionsPath, sessionFilesFolder } from '@/filePaths';
import { createIPCServer, IPCServer } from '../eventSystem/ipcServer';
import { createLockFile, deleteLockFile, lockFileExist, LockFiles } from '../eventSystem/lockFiles';
import * as nvim from 'neovim';
import fs from 'fs/promises';
import { getSessionsFromSaved, quickSave } from '@/tmux';
import { loadSettings } from '@/utils/common';

const scheduledJobs: string[] = [];

let saveTimer: NodeJS.Timeout | undefined;
let server: IPCServer | undefined;

async function resetSaveTimer(timeout: number = undefined!) {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        await deleteLockFile(LockFiles.AutoSaveInProgress);
        process.exit(0);
    }

    if (saveTimer) {
        clearTimeout(saveTimer)
    }

    const settings = await loadSettings();

    saveTimer = setTimeout(async () => {
        if (scheduledJobs.length > 0) {
            const saveFileName = settings.autosave.currentSession;
            let session;

            try {
                session = await getSessionsFromSaved(saveFileName);
            } catch (error) {
                console.log(error);
            }

            if (!session) {
                return;
            }

            let sessionChanged = false;

            try {
                for (const job of scheduledJobs) {
                    if (job.startsWith('neovim')) {
                        const splitJob = job.split(':');
                        const folderName = saveFileName;
                        const sessionName = splitJob[1];
                        const windowIndex = +splitJob[2];
                        const paneIndex = +splitJob[3];

                        const nvimSessionFileName = `${sessionName}_${windowIndex}_${paneIndex}.vim`

                        const currentCommand = session[sessionName]?.windows[windowIndex]?.panes[paneIndex]?.currentCommand;

                        if (splitJob[splitJob.length - 2] === 'VimLeave') {
                            console.log('job vim leave');
                            await fs.unlink(`${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`);

                            if (currentCommand && currentCommand === "nvim") {
                                session[sessionName].windows[windowIndex].panes[paneIndex].currentCommand = "";
                                sessionChanged = true;
                            }
                        } else {
                            const socket = splitJob[splitJob.length - 1];

                            const neovim = nvim.attach({ socket })
                                .on('error', () => console.log('error'))
                                .on('disconnect', () => console.log('neovim disconnected'));

                            console.log(neovim);

                            await neovim.command(`mksession! ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`);
                            await neovim.command(`echo 'kra workflow autosaved : ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}'`);

                            if (currentCommand && currentCommand !== "nvim") {
                                session[sessionName].windows[windowIndex].panes[paneIndex].currentCommand = "nvim";
                                sessionChanged = true;
                            }
                        }
                    }
                }

                if (scheduledJobs.includes('tmux')) {
                    await quickSave(saveFileName);
                    sessionChanged = false;
                }

                if (sessionChanged) {
                    await fs.writeFile(`${sessionFilesFolder}/${saveFileName}`, JSON.stringify(session, null, 2));
                }
            } catch (error) {
                console.log(error);
            } finally {
                await deleteLockFile(LockFiles.AutoSaveInProgress);
                server?.close();
                process.exit(0);
            }
        }
    }, timeout || settings.autosave.timeoutMs);
}

async function main(): Promise<void> {
    try {
        const server = createIPCServer('/tmp/autosave.sock');

        await server.addListener(async (event) => {
            if (event === 'interrupt') {
                resetSaveTimer(0);

                return;
            }

            console.log(event);
            if (!scheduledJobs.includes(event)) {
                scheduledJobs.push(event);
            }
            console.log(scheduledJobs);
            resetSaveTimer();
        });

        await createLockFile(LockFiles.AutoSaveInProgress);
        resetSaveTimer();
    } catch (error) {
        console.log(error);
    }
}

main().then((_res) => console.log('done'));
