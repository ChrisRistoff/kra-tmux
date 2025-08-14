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
import { SessionWorkerData, WorkerResult } from '@/types/workerTypes';
import { Worker } from 'worker_threads';

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
        const workerData: SessionWorkerData = {
            sessionName,
            sessionData: { [sessionName]: savedData.sessions[sessionName] },
            fileName: savedData.fileName
        };

        const worker = new Worker(path.join(__dirname, '../workers/loadSessionWorker.js'), {
            workerData
        });

        const cleanup = () => {
            worker.terminate().catch(console.error);
        };

        worker.on('message', (result: WorkerResult) => {
            cleanup();
            if (result.success) {
                console.log(`✅ Session ${result.sessionName} created successfully`);
                resolve(result);
            } else {
                console.error(`❌ Session ${result.sessionName} failed: ${result.error}`);
                reject(new Error(result.error));
            }
        });

        worker.on('error', (error) => {
            cleanup();
            console.error(`Worker error for session ${sessionName}:`, error);
            reject(error);
        });

        worker.on('exit', (code) => {
            cleanup();
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
};

export async function loadSession(): Promise<void> {
    try {
        await createLockFile(LockFiles.LoadInProgress);
        const savedData = await getSessionsFromSaved();

        if (!savedData || !Object.keys(savedData.sessions).length) {
            console.error('No saved sessions found.');
            await deleteLockFile(LockFiles.LoadInProgress);
            return;
        }

        const sessionKeys = Object.keys(savedData.sessions);
        console.log(`Loading ${sessionKeys.length} sessions in parallel...`);

        // Fire all workers at once for maximum speed
        const workerPromises = sessionKeys.map(sessionName =>
            createWorkerPromise(sessionName, savedData)
        );

        const results = await Promise.allSettled(workerPromises);

        // Log results
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                console.log(`✅ Session ${sessionKeys[index]} created successfully`);
            } else {
                console.error(`❌ Session ${sessionKeys[index]} failed:`, result.reason);
            }
        });

        await tmux.sourceTmuxConfig();
        await deleteLockFile(LockFiles.LoadInProgress);
    } catch (error) {
        console.log(error);
    }
};

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
