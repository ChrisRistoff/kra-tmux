import { getCurrentSessions } from '@/tmux/utils/sessionUtils';
import { TmuxSessions } from '@/types/sessionTypes';

/**
 * Prints all current tmux sessions by fetching session data and passing it to printSessions
 */
export async function printCurrentSessions(): Promise<void> {
    const sessions = await getCurrentSessions();
    printSessions(sessions);
}

/**
 * Formats and prints tmux session information in a table format
 * @param sessions - Tmux session data to display
 * @remarks
 * - Path displays the current working directory of the first window found with a path
 * - Windows count shows the number of windows in each session
 * - Panes count aggregates all panes across all windows in a session
 */
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
