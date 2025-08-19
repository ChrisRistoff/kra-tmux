import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import { sessionFilesFolder } from '@/filePaths';
import { TmuxSessions, Window, Pane } from '@/types/sessionTypes';
import { formatWindow, formatPane } from '@/tmux/utils/formatters';
import { filterGitKeep } from '@/utils/common';

/**
 * Retrieves all current tmux sessions with their associated windows
 * @returns Promise resolving to TmuxSessions object containing all active sessions
 * and their window and panes configurations. Returns empty object on error.
 */
export async function getCurrentSessions(): Promise<TmuxSessions> {
    let output;
    const currentSessions: TmuxSessions = {};

    try {
        output = await bash.execCommand(`tmux list-sessions -F '#S'`);
    } catch (_error) {
        return currentSessions;
    }

    const sessions = output.stdout.toString().trim().split('\n');

    for (const session of sessions) {
        const windows = await getWindowsForSession(session);
        currentSessions[session] = { windows };
    }

    return currentSessions;
}

/**
 * Gets detailed window information for a specific tmux session
 * @param session - Name of the tmux session to inspect
 * @returns Promise resolving to array of Window objects containing window details,
 *          including formatted layout and associated panes. Returns empty array on error.
 */
export async function getWindowsForSession(session: string): Promise<Window[]> {
    const windows = await bash.execCommand(
        `tmux list-windows -t ${session} -F "#{window_name}:#{pane_current_command}:#{pane_current_path}:#{window_layout}"`
    );
    const windowsArray = windows.stdout.toString().trim().split('\n');
    const formattedWindows: Window[] = [];

    for (const [index, window] of windowsArray.entries()) {
        const formattedWindow = await formatWindow(window);
        const panes = await getPanesForWindow(session, index);
        formattedWindow.panes = panes;
        formattedWindows.push(formattedWindow);
    }

    return formattedWindows;
}

/**
 * Retrieves pane information for a specific window in a tmux session
 * @param session - Name of the tmux session containing the window
 * @param windowIndex - Numeric index of the window to inspect
 * @returns Promise resolving to array of Pane objects with process and position details.
 *          Returns empty array if pane retrieval fails.
 */
export async function getPanesForWindow(session: string, windowIndex: number): Promise<Pane[]> {
    try {
        const panes = await bash.execCommand(
            `tmux list-panes -t ${session}:${windowIndex} -F "#{pane_pid}:#{pane_current_path}:#{pane_left}x#{pane_top}"`
        );
        const panesArray = panes.stdout.toString().trim().split('\n');

        return Promise.all(panesArray.map(formatPane));
    } catch (error) {
        console.log('Error getting panes:', error);

        return [];
    }
}

/**
 * Gets list of saved session names from persistent storage
 * @returns Promise resolving to array of session names, excluding .gitkeep files.
 *          Returns empty array if directory read fails.
 */
export async function getSavedSessionsNames(): Promise<string[]> {
    try {
        return filterGitKeep(await fs.readdir(sessionFilesFolder));
    } catch (error) {
        console.error('Error reading directory:', error);

        return [];
    }
}

/**
 * Loads saved tmux session configuration from a specific file
 * @param filePath - Full path to the session configuration file
 * @returns Promise resolving to TmuxSessions object parsed from JSON file
 */
export async function getSavedSessionsByFilePath(filePath: string): Promise<TmuxSessions> {
    const latestSessions = await fs.readFile(filePath);

    return JSON.parse(latestSessions.toString());
}

/**
 * Generates standardized date string for file naming
 * @returns String formatted as YYYY-MMM-DD-HHMM (e.g. "2023-Aug-25-1430")
 */
export function getDateString(): string {
    const dateArray = new Date().toString().split(' ');
    const timeArray = dateArray[4].split(':');
    timeArray.pop();
    const timeString = timeArray.join(':');

    return [dateArray[3], dateArray[1], dateArray[2], timeString].join('-');
}
