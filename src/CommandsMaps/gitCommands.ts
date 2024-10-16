import { GitRestore } from "../Git/GitRestore";

const gitRestore = new GitRestore();

type GitCommands = {
    [key: string]: () => Promise<void>
}

export const gitCommands: GitCommands = {
    'git': handleGitRestore
}

async function handleGitRestore(): Promise<void> {
    await gitRestore.restoreFile();
}
