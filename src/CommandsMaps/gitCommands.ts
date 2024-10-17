import { GitRestore } from "../Git/GitRestore";
import { GitUntracked } from "../Git/GitUntracked";
import readline from "readline";

// Create instances of your Git command handlers
const gitRestore = new GitRestore();
const gitUntracked = new GitUntracked();

// Define available Git commands and subcommands
const gitSubcommands = ['res', 'store', 'ret'];
const mainCommands = ['git'];

type GitCommands = {
    [key: string]: (args?: any) => Promise<void>
};

export const gitCommands: GitCommands = {
    'git': handleGit
};

// Enhanced autocompletion function
function completer(line: string) {
    const args = line.split(' ');

    // Autocomplete the main command ('git')
    if (args.length === 1) {
        const hits = mainCommands.filter((c) => c.startsWith(line));
        return [hits.length ? hits : mainCommands, line];
    }

    // Autocomplete the subcommands after 'git'
    if (args[0] === 'git' && args.length === 2) {
        const subHits = gitSubcommands.filter((sub) => sub.startsWith(args[1]));
        return [subHits.length ? subHits : gitSubcommands, line];
    }

    return [[], line];  // No autocomplete for anything beyond subcommands
}

// Setup readline interface with autocompletion
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer,
    prompt: 'Your command> ',
});

rl.prompt();

rl.on('line', async (input: string) => {
    const args = input.trim().split(' ');

    if (args[0] === 'git') {
        await gitCommands.git(args);
    } else {
        console.log('Unknown command');
    }

    rl.prompt(); // Prompt again after command execution
}).on('close', () => {
    console.log('Exiting...');
    process.exit(0);
});

// Main function to handle Git commands
async function handleGit(args: string[]): Promise<void> {
    switch (args[1]) {
        case 'res':
            await gitRestore.restoreFile();
            break;
        case 'store':
            await gitUntracked.saveUntrackedFile();
            break;
        case 'ret':
            await gitUntracked.loadUntrackedFile();
            break;
        default:
            console.log('Git command not found');
    }
}

