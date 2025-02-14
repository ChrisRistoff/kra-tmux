import * as git from "@git/index";
import { Commands } from "./types/commandTypes";

export const gitCommands: Commands = {
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
