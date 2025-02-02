import * as sessions from '@sessions/index'

type TmuxCommands = {
    [key: string]: () => Promise<void>,
}

export const tmuxCommands: TmuxCommands = {
    'save-server': sessions.saveSessionsToFile,
    'load-server': handleLoadSession,
    'list-sessions': sessions.printCurrentSessions,
    'delete-session': sessions.deleteSession,
    'kill': sessions.killServer,
};

async function handleLoadSession(): Promise<void> {
    await sessions.handleSessionsIfServerIsRunning();
    await sessions.loadLatestSession();
}
