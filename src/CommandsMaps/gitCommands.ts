import * as git from "../git";
import { GitCommands } from "../git/types/gitTypes";

export const gitCommands: GitCommands = {
    'restore': git.restoreFile,
    'cache-untracked': git.saveUntracked,
    'retrieve-untracked': git.loadUntracked,
    'hard-reset': git.hardReset,
    'log': git.getGitLog,
    'stash': git.applyOrDropStash,
    'stash-drop-multiple': git.dropMultipleStashes,
    'conflict-handle': git.handleConflicts,
};
