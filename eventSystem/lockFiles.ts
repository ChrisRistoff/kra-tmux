import { loadSettings } from "@/utils/common";
import { lockFilesPath } from "../src/filePaths";
import * as fs from 'fs/promises';

export enum LockFiles {
    LoadInProgress = 'LoadInProgress',
    AutoSaveInProgress = 'AutoSaveInProgress',
    ServerKillInProgress = 'ServerKillInProgress',
}

export async function deleteLockFile(type: LockFiles): Promise<void> {
    try {
        await fs.rm(`${lockFilesPath}/${type}`);
    } catch (error) {
        console.log(error);
    }
}

export async function oneOfMultipleLocksExist(types: LockFiles[]): Promise<boolean> {
    const res = await Promise.all(types
        .map(async (fileType) => lockFileExist(fileType)))

    return res.some(file => file);
}

export async function lockFileExist(type: LockFiles): Promise<boolean> {
    try {
        const data = await fs.readFile(`${lockFilesPath}/${type}`, 'utf-8');
        const lockInfo = JSON.parse(data);

        const timeouts = {
            [LockFiles.LoadInProgress]: 10 * 1000,          // 5s - loading takes ms, this should be more than safe to assume
            [LockFiles.AutoSaveInProgress]: await loadSettings().then((set) => set.autosave.timeoutMs) + 10000, // autosave timeout + 10 sec buffer
            [LockFiles.ServerKillInProgress]: 5 * 1000   // 5s - kill session is instant, 5s is enough to complete the autosave
        };

        // check if lock is stale (older than X seconds)
        const xSecondsAgo = Date.now() - (timeouts[type]);

        if (lockInfo.timestamp < xSecondsAgo) {
            console.log(`Removing stale ${type} lock file`);
            await deleteLockFile(type);

            return false;
        }

        return true;
    } catch (error) {
        // if we can't read the lock file assume it doesn't exist
        return false;
    }
}

export async function createLockFile(type: LockFiles): Promise<void> {
    const lockData = {
        timestamp: Date.now(),
    };

    await fs.writeFile(`${lockFilesPath}/${type}`, JSON.stringify(lockData));
}
