import { lockFilesPath } from "@/filePaths";
import * as fs from 'fs/promises';

export enum LockFiles {
    LoadInProgress = 'LoadInProgress',
    AutoSaveInProgress = 'AutoSaveInProgress',
}

export async function createLockFile(type: LockFiles): Promise<void> {
    await fs.writeFile(`${lockFilesPath}/${type}`, ' ');
}

export async function deleteLockFile(type: LockFiles): Promise<void> {
    if (await lockFileExist(type)) {
        await fs.rm(`${lockFilesPath}/${type}`);
    }
}

export async function lockFileExist(type: LockFiles): Promise<boolean> {
    try {
        await fs.access(`${lockFilesPath}/${type}`);

        return true;
    } catch (error) {
        return false;
    }
}
