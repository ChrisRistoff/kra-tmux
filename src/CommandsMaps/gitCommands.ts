import { GitRestore } from "../Git/GitRestore";
import { GitUntracked } from "../Git/GitUntracked";

const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();

type GitCommands = {
    [key: string]: (args?: string[]) => Promise<void>
}

export const gitCommands: GitCommands = {
    'restore': handleRestore,
    'cache-untracked': handleCacheUntracked,
    'retrieve-untracked': handleRetrieveUntracked,
};

async function handleRestore (): Promise<void> {
    await gitRestore.restoreFile();
}

async function handleCacheUntracked(): Promise<void> {
    await gitUntracked.saveUntracked();
}

async function handleRetrieveUntracked() {
    await gitUntracked.loadUntracked();
}
