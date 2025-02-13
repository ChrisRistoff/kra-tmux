import * as fs from 'fs/promises';
import * as bash from '@utils/bashHelper';
import { sessionFilesFolder } from '@filePaths';
import { TmuxSessions, Window, Pane } from '@customTypes/sessionTypes';
import { formatWindow, formatPane } from '@sessions/utils/formatters';
import { filterGitKeep } from '@/utils/common';

export async function getCurrentSessions(): Promise<TmuxSessions> {
    let output;
    const currentSessions: TmuxSessions = {};

    try {
        output = await bash.execCommand(`tmux list-sessions -F '#S'`);
    } catch (error) {
        console.log(error);

        return currentSessions;
    }

    const sessions = output.stdout.toString().trim().split('\n');

    for (const session of sessions) {
        const windows = await getWindowsForSession(session);
        currentSessions[session] = { windows };
    }

    return currentSessions;
}

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

export async function getPanesForWindow(session: string, windowIndex: number): Promise<Pane[]> {
    try {
        const panes = await bash.execCommand(
            `tmux list-panes -t ${session}:${windowIndex} -F "#{pane_current_command}:#{pane_current_path}:#{pane_left}x#{pane_top}"`
        );
        const panesArray = panes.stdout.toString().trim().split('\n');

        return Promise.all(panesArray.map(formatPane));
    } catch (error) {
        console.log('Error getting panes:', error);

        return [];
    }
}

export async function getSavedSessionsNames(): Promise<string[]> {
    try {
        return filterGitKeep(await fs.readdir(sessionFilesFolder));
    } catch (error) {
        console.error('Error reading directory:', error);

        return [];
    }
}

export async function getSavedSessionsByFilePath(filePath: string): Promise<TmuxSessions> {
    const latestSessions = await fs.readFile(filePath);

    return JSON.parse(latestSessions.toString());
}

export function getDateString(): string {
    const dateArray = new Date().toString().split(' ');
    const timeArray = dateArray[4].split(':');
    timeArray.pop();
    const timeString = timeArray.join(':');

    return [dateArray[3], dateArray[1], dateArray[2], timeString].join('-');
}
