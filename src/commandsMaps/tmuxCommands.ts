import * as sessions from '@sessions/index'
import { TmuxCommands } from './types/commandTypes';

export const tmuxCommands: TmuxCommands = {
    'save-server': sessions.saveSessionsToFile,
    'load-server': loadSession,
    'list-sessions': sessions.printCurrentSessions,
    'delete-session': sessions.deleteSession,
    'kill': sessions.killServer,
};

async function loadSession(): Promise<void> {
    await sessions.handleSessionsIfServerIsRunning();
    await sessions.loadLatestSession();
}
