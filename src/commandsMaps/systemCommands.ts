import * as systemFileManager from "@/system/commands/systemFileManager";
import * as scripts from "@/system/commands/scripts/executeScripts";
import { SystemCommands } from "@/commandsMaps/types/commandTypes";

export const systemCommands: SystemCommands = {
    'grep-file-remove': {
        run: systemFileManager.removeFile,
        description: 'Search for matching files and delete the ones you pick',
        details: 'Interactive cleanup flow for files. Search by name, review the matches, and only remove the entries you explicitly confirm.',
        highlights: [
            'Useful for cleaning generated or duplicated files safely.',
            'Keeps deletion interactive instead of forcing a raw rm command.',
            'Focused on file-name searching before removal.',
        ],
    },
    'grep-dir-remove': {
        run: systemFileManager.removeDirectory,
        description: 'Search for matching directories and delete the ones you pick',
        details: 'Directory version of the interactive cleanup flow. Search for matching folders, inspect the candidates, and remove only the ones you choose.',
        highlights: [
            'Good for cleaning caches, build folders, or abandoned workspaces.',
            'Mirrors the file-removal flow so both cleanup tools feel the same.',
            'Keeps recursive deletion behind an explicit picker-based action.',
        ],
    },
    'scripts': {
        run: scripts.executeScript,
        description: 'Browse and run repository automation scripts',
        details: 'Open the script picker for repo automation tasks and run the selected script through the shared menu flow.',
        highlights: [
            'Central entry point for repo-specific automation helpers.',
            'Lets you browse available scripts before running them.',
            'Keeps script execution grouped with the other system utilities.',
        ],
    },
};