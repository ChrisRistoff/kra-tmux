import { GitRestore } from "../Git/GitRestore";
import { GitUntracked } from "../Git/GitUntracked";

const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();

type GitCommands = {
    [key: string]: (args?: any) => Promise<void>
}

export const gitCommands: GitCommands = {
    'git': handleGit
}

async function handleGit(args: string[]): Promise<void> {
    switch(args[1]) {
        case 'res':
            await gitRestore.restoreFile();
            break;
        case 'store':
            await gitUntracked.saveUntrackedFile();
            break;
        case 'restore':
            await gitUntracked.loadUntrackedFile();
            break;
        default:
            console.log('Git command not found');
    }
}
