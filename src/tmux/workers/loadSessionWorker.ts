import 'module-alias/register';
import { parentPort, workerData } from 'worker_threads';
import * as bash from '../../utils/bashHelper';
import { WorkerResult } from '@/types/workerTypes';

const executeWorker = async (): Promise<void> => {
    try {
        const { sessionName, sessionData } = workerData;
        const sessionConfig = sessionData[sessionName];

        // Create base session
        await bash.execCommand(`tmux new-session -d -s ${sessionName} -c ~/`);

        // Return window data for parallel processing
        const result: WorkerResult = {
            sessionName,
            success: true,
            windows: sessionConfig.windows
        };

        parentPort?.postMessage(result);
    } catch (error) {
        parentPort?.postMessage({
            sessionName: workerData.sessionName,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

executeWorker();
