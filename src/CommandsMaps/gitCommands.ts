import { BaseGit } from "../Git/BaseGit";
import { GitConflict } from "../Git/GitConflict";
import { GitRestore } from "../Git/GitRestore";
import { GitStash } from "../Git/GitStash";
import { GitUntracked } from "../Git/GitUntracked";

const baseGit = new BaseGit();
const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();
const gitStash = new GitStash();
const gitConflict = new GitConflict();

type GitCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const gitCommands: GitCommands = {
    'restore': handleRestore,
    'cache-untracked': handleCacheUntracked,
    'retrieve-untracked': handleRetrieveUntracked,
    'hard-reset': handleHardResetCurrentBranch,
    'log': handleGitLog,
    'stash': handleStash,
    'stash-drop-multiple': handleStashDropMultiple,
    'conflict-handle': handleGitConflict,
};

async function handleRestore (): Promise<void> {
    await gitRestore.restoreFile();
}

async function handleCacheUntracked(): Promise<void> {
    await gitUntracked.saveUntracked();
}

async function handleRetrieveUntracked(): Promise<void> {
    await gitUntracked.loadUntracked();
}

async function handleHardResetCurrentBranch(): Promise<void> {
    await baseGit.hardResetCurrentBranch();
}

async function handleGitLog(): Promise<void> {
    await baseGit.getGitLog();
}

async function handleStash(): Promise<void> {
    gitStash.applyOrDropStash();
}

async function handleStashDropMultiple(): Promise<void> {
    gitStash.dropMultipleStashes();
}

async function handleGitConflict(): Promise<void> {
    gitConflict.handleConflicts();
}
