import { getCurrentSessions } from '@tmux/utils/sessionUtils';
import { TmuxSessions } from '@customTypes/sessionTypes';

export async function printCurrentSessions(): Promise<void> {
    const sessions = await getCurrentSessions();
    printSessions(sessions);
}

export function printSessions(sessions: TmuxSessions): void {
    for (const sess in sessions) {
        const currentSession = sessions[sess];
        let panesCount = 0;
        let path = '';

        for (const window of currentSession.windows) {
            path = path || window.currentPath;
            panesCount += window.panes.length;
        }

        console.table({
            Name: sess,
            Path: path,
            Windows: currentSession.windows.length,
            Panes: panesCount,
        });
    }
}
