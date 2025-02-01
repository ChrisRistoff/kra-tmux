import * as systemFileManager from "../system/systemFileManager";

type SystemCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const systemCommands: SystemCommands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
};

