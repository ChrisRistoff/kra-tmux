import * as systemFileManager from "@/system/commands/systemFileManager";
import * as scripts from "@/system/commands/scripts/executeScripts";
import * as systemProcessManager from "@/system/commands/systemProcessManager";
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
    'process-manager': {
        run: systemProcessManager.openProcessManager,
        description: 'Browse and kill OS processes interactively',
        details: 'Open a multi-pane TUI dashboard showing all running processes with stats. Search by PID, user, or command name. Send SIGTERM or SIGKILL to selected processes with confirmation.',
        highlights: [
            'Interactive process inspection with full details on demand.',
            'Kill processes safely with y/n confirmation prompts.',
            'Refresh the process list with r without losing your current selection.',
        ],
    },
};