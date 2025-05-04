import * as git from "@git/index";
import { GitCommands } from "./types/commandTypes";
import { gitAscii } from "@/git/data/git-ascii";

export const gitCommands: GitCommands = {
    'restore': git.restoreFile,
    'cache-untracked': git.saveUntracked,
    'retrieve-untracked': git.loadUntracked,
    'hard-reset': git.hardReset,
    'log': git.getGitLog,
    'stash': git.applyOrDropStash,
    'stash-drop-multiple': git.dropMultipleStashes,
    'conflict-handle': git.handleConflicts,
    'view-changed': git.handleViewChanged,
};

export function handleGitCommandNotExist(commandName: string): void {
    if (Object.keys(gitCommands).includes(commandName)) {
        return;
    }

    console.log(gitAscii);

    if (commandName) {
        console.table({[`${commandName}`]: 'Is not a valid command'});
    }

    process.exit(1);
}
