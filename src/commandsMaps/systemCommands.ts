import * as systemFileManager from "../System/SystemFileManager";

type SystemCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const systemCommands: SystemCommands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
};

