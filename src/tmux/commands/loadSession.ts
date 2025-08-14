import path from 'path';
import * as fs from 'fs/promises';
import * as utils from '@/utils/common';
import * as generalUI from '@/UI/generalUI';
import { sessionFilesFolder } from '@/filePaths';
import { TmuxSessions } from '@/types/sessionTypes';
import { getCurrentSessions, getSavedSessionsNames } from '@/tmux/utils/sessionUtils';
import { printSessions } from '@/tmux/commands/printSessions';
import * as tmux from '@/tmux/core/tmux';
import { saveSessionsToFile } from '@/tmux/commands/saveSessions';
import { createLockFile, deleteLockFile, LockFiles } from '@/../eventSystem/lockFiles'
import { WorkerResult } from '@/types/workerTypes';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import PQueue from 'p-queue';

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

const createWorkerPromise = (
    sessionName: string,
    savedData: any
): Promise<WorkerResult> => {
    return new Promise((resolve, reject) => {
        const workerData = {
            sessionName,
            sessionData: { [sessionName]: savedData.sessions[sessionName] },
            fileName: savedData.fileName
        };

        const worker = new Worker(path.join(__dirname, '../workers/loadSessionWorker.js'), {
            workerData
        });

        const cleanup = () => worker.terminate().catch(console.error);

        worker.on('message', (result: WorkerResult) => {
            cleanup();
            result.success ? resolve(result) : reject(result.error);
        });

        worker.on('error', reject);
        worker.on('exit', code => code !== 0 && reject(`Exit code ${code}`));
    });
};

export async function loadSession(): Promise<void> {
    try {
        await createLockFile(LockFiles.LoadInProgress);
        const savedData = await getSessionsFromSaved();

        if (!savedData?.sessions) {
            console.error('No saved sessions found.');
            await deleteLockFile(LockFiles.LoadInProgress);
            return;
        }

        const sessionQueue = new PQueue({ concurrency: cpus().length });
        const sessionNames = Object.keys(savedData.sessions);

        const processSession = async (sessionName: string, serverName: string) => {
            const result = await createWorkerPromise(sessionName, savedData);
            const windowQueue = new PQueue({ concurrency: 4 });

            for (const [windowIndex, window] of result.windows.entries()) {
                await windowQueue.add(() =>
                    new Promise((resolve, reject) => {
                        const worker = new Worker(path.join(__dirname, '../workers/windowWorker.js'), {
                            workerData: { sessionName, windowIndex, window, serverName }
                        });

                        worker.on('message', resolve);
                        worker.on('error', reject);
                        worker.on('exit', code =>
                            code !== 0 ? reject(`Exit code ${code}`) : resolve(null)
                        );
                    })
                );
            }
        };

        await sessionQueue.addAll(sessionNames.map(sessionName =>
            () => processSession(sessionName, savedData.fileName)
        ));

        await tmux.sourceTmuxConfig();
        await deleteLockFile(LockFiles.LoadInProgress);
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
