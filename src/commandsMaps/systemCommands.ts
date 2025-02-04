import * as systemFileManager from "@system/systemFileManager";
import { Commands } from "./types/commandTypes";

export const systemCommands: Commands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
};

