import * as sessions from '@sessions/index'
import { TmuxCommands } from './types/commandTypes';
import { tmuxAscii } from '@/sessions/data/tmux-ascii';

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

export function handleTmuxCommandNotExist(commandName: string): void {
    if (Object.keys(tmuxCommands).includes(commandName)) {
        return;
    }

    console.log(tmuxAscii);

    if (commandName) {
        console.table({[`${commandName}`]: 'Is not a valid command'});
    }

    process.exit(1);
}
