import { GitRestore } from "../Git/GitRestore";
import { GitUntracked } from "../Git/GitUntracked";

const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();

type GitCommands = {
    [key: string]: (args?: any) => Promise<void>
}

export const gitCommands: GitCommands = {
    'restore': handleRestore,
    'cache-untracked': handleCacheUntracked,
    'retrieve-untracked': handleRetrieveUntracked,
}

async function handleRestore (): Promise<void> {
    await gitRestore.restoreFile();
}

async function handleCacheUntracked(): Promise<void> {
    await gitUntracked.saveUntrackedFile();
}

async function handleRetrieveUntracked() {
    await gitUntracked.loadUntrackedFile();
}
