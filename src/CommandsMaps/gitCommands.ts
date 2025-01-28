import { BaseGit } from "../Git/BaseGit";
import { GitRestore } from "../Git/GitRestore";
import { GitUntracked } from "../Git/GitUntracked";

const baseGit = new BaseGit();
const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();

type GitCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const gitCommands: GitCommands = {
    'restore': handleRestore,
    'cache-untracked': handleCacheUntracked,
    'retrieve-untracked': handleRetrieveUntracked,
    'hard-reset': handleHardResetCurrentBranch,
    'log': handleGitLog,
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
