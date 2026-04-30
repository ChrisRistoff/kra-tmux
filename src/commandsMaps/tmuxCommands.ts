import * as sessions from '@/tmux/index';
import { TmuxCommands } from '@/commandsMaps/types/commandTypes';

async function loadSession(): Promise<void> {
    await sessions.handleSessionsIfServerIsRunning();
    await sessions.loadSession();
}

export const tmuxCommands: TmuxCommands = {
    'save-server': {
        run: sessions.saveSessionsToFile,
        description: 'Save the current tmux server state into a named file',
        details: 'Capture the running tmux server so it can be restored later with its sessions, windows, panes, working directories, and editor state.',
        highlights: [
            'Built for full workspace persistence, not just one session.',
            'Saves the structure you would otherwise need to rebuild manually.',
            'Useful when pausing work across tickets or projects.',
        ],
    },
    'load-server': {
        run: loadSession,
        description: 'Load a saved tmux session file back into tmux',
        details: 'Choose a saved server file and rebuild the tmux layout it describes, including the working directories and saved session structure.',
        highlights: [
            'Restores saved workspaces quickly after restarts or context switches.',
            'Pairs directly with save-server for round-trip persistence.',
            'Keeps the restore flow behind the shared interactive menu.',
        ],
    },
    'list-sessions': {
        run: sessions.printCurrentSessions,
        description: 'Print the tmux sessions that are running right now',
        details: 'Read-only summary of the active tmux server when you want to see current sessions without opening the save-management dashboard.',
        highlights: [
            'Fast textual overview of what is live right now.',
            'Good for quick checks from the terminal.',
            'Does not modify saved sessions or server state.',
        ],
    },
    'manage-server': {
        run: sessions.manageSessions,
        description: 'Open the tmux save-management dashboard',
        details: 'Shared multi-pane dashboard for browsing saved tmux files, previewing their structure, deleting or renaming saves, and building a new save interactively.',
        highlights: [
            'Shows meaningful save details in side panels, not just a file list.',
            'Includes management actions and the save-builder overlay.',
            'Acts as the main home for saved tmux workspace maintenance.',
        ],
    },
    'kill': {
        run: sessions.killServer,
        description: 'Kill the currently running tmux server',
        details: 'Stop the active tmux server and every session attached to it when you want a hard reset of the current tmux runtime.',
        highlights: [
            'Affects the live server, not saved layouts on disk.',
            'Useful when the current tmux state should be cleared entirely.',
            'Kept explicit so the destructive action is easy to identify.',
        ],
    },
};