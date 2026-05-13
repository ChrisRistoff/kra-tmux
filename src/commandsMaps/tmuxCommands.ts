import * as sessions from '@/tmux/index';
import { TmuxCommands } from '@/commandsMaps/types/commandTypes';

async function loadServer(): Promise<void> {
    await sessions.handleServerIfRunning();
    await sessions.loadServer();
}

async function loadSession(): Promise<void> {
    await sessions.loadSession();
}

export const tmuxCommands: TmuxCommands = {
    'save-server': {
        run: sessions.saveServerToFile,
        description: 'Save the current tmux server state into a named file',
        details: 'Capture the running tmux server so it can be restored later with its sessions, windows, panes, working directories, and editor state.',
        highlights: [
            'Built for full workspace persistence, not just one session.',
            'Saves the structure you would otherwise need to rebuild manually.',
            'Useful when pausing work across tickets or projects.',
        ],
    },
    'load-server': {
        run: loadServer,
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
    'manage-saves': {
        run: sessions.manageSaves,
        description: 'Open the tmux save-management dashboard (servers + sessions)',
        details: 'Two-tab dashboard for browsing saved tmux files. Press 1 for server saves, 2 for single-session saves. Browse, preview, rename, delete, or build a new save interactively.',
        highlights: [
            'Tab 1 manages full-server saves; tab 2 manages single-session saves.',
            'Same browsing, rename, delete, and new-save flow on both tabs.',
            'Press 1 / 2 at any time to switch tabs.',
        ],
    },
    'save-session': {
        run: sessions.saveSession,
        description: 'Save a single tmux session into a named file',
        details: 'Pick one running tmux session (defaulting to the attached one) and persist just that session\'s windows and panes, including nvim editor state, into the single-session save folder.',
        highlights: [
            'Captures one session, not the whole server.',
            'Useful for sharing or reloading individual workspaces.',
            'Does not touch the autosave current-session marker.',
        ],
    },
    'load-session': {
        run: loadSession,
        description: 'Load a saved single-session file into the current tmux server',
        details: 'Pick a saved single-session file and recreate that one session inside the running tmux server, leaving any other sessions untouched. On a name collision you can rename, overwrite, or cancel.',
        highlights: [
            'Adds a session to the current server instead of replacing it.',
            'Pairs with save-session for round-trip persistence of one session.',
            'Prompts before clobbering an existing session of the same name.',
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
