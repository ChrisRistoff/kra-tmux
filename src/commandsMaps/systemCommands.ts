import * as systemFileManager from "@/system/commands/systemFileManager";
import * as scripts from "@/system/commands/scripts/executeScripts";
import { SystemCommands } from "@/commandsMaps/types/commandTypes";
import { sysAscii } from "@/system/data/sys-ascii";

export const systemCommands: SystemCommands = {
    'grep-file-remove': systemFileManager.removeFile,
    'grep-dir-remove': systemFileManager.removeDirectory,
    'scripts': scripts.executeScript,
};

export function handleSysCommandNotExist(commandName: string): void {
    if (Object.keys(systemCommands).includes(commandName)) {
        return;
    }

    console.log(sysAscii);

    if (commandName) {
        console.table({[`${commandName}`]: 'Is not a valid command'});
    }

    process.exit(1);
}
