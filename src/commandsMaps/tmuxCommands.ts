import * as sessions from '@tmux/index'
import { TmuxCommands } from './types/commandTypes';
import { tmuxAscii } from '@/tmux/data/tmux-ascii';

export const tmuxCommands: TmuxCommands = {
    'save-server': sessions.saveSessionsToFile,
    'load-server': loadSession,
    'list-sessions': sessions.printCurrentSessions,
    'delete-server': sessions.deleteSession,
    'kill': sessions.killServer,
    'quicksave': sessions.quickSave,
};

async function loadSession(): Promise<void> {
    await sessions.handleSessionsIfServerIsRunning();
    await sessions.loadSession();
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
