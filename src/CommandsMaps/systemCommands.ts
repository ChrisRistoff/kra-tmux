import { SystemFileManager } from "../System/SystemFileManager";

const systemFileManager = new SystemFileManager();

type SystemCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const systemCommands: SystemCommands = {
    'grep-file-remove': grepAndRemoveFile,
    'grep-dir-remove': grepAndRemoveDir,
};

async function grepAndRemoveFile() {
    systemFileManager.removeGreppedFile();
}

async function grepAndRemoveDir() {
    systemFileManager.removeGreppedDir();
}
