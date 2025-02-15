import * as systemFileManager from "@system/commands/systemFileManager";
import * as scripts from "@system/commands/scripts/executeScripts";
import { SystemCommands } from "./types/commandTypes";

export const systemCommands: SystemCommands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
    'scripts': scripts.executeScript,
};
