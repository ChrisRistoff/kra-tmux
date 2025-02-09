import * as systemFileManager from "@system/commands/systemFileManager";
import * as scripts from "@system/commands/scripts/executeScripts";
import { Commands } from "./types/commandTypes";

export const systemCommands: Commands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
    'scripts': scripts.executeScript,
};
