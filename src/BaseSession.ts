import * as bash from './helpers/bashHelper';
import { TmuxSessions, Window, Pane } from './types/SessionTypes';
import { Base } from './Base';
import { PaneSplitDirection } from './enums/SessionEnums';

export class BaseSessions extends Base {
    public currentSessions: TmuxSessions;

    constructor () {
        super()
        this.currentSessions = {};
    }

    public setCurrentSessions(): void {
        const output = bash.execCommand(`tmux list-sessions -F '#S'`);
        const sessions = output.toString().trim().split('\n');

        for (const session of sessions) {
            const windows = bash.execCommand(`tmux list-windows -t ${session} -F "#{window_index}:#{window_name}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`).toString().trim().split('\n');

            for (const window of windows) {
                const formattedWindow = this.formatWindow(window);

                if (this.currentSessions[session]) {
                    this.currentSessions[session].windows.push(formattedWindow);
                } else {
                    this.currentSessions[session] = {
                        windows: [formattedWindow]
                    }
                }
            }

            for (let i = 0; i < windows.length; i++) {
                const windowIndex = i;
                const panes = bash.execCommand(`tmux list-panes -t ${session}:${i} -F "#{pane_index}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`).toString().trim().split('\n');

                for (let i = 0; i < panes.length; i++) {
                    const pane = this.formatPane(panes[i])
                    this.currentSessions[session].windows[windowIndex].panes.push(pane);
                }
            }
        }
    }

    public async checkTmuxSessionExists(sessionName: string): Promise<boolean> {
        try {
            await bash.execCommand(`tmux has-session -t ${sessionName}`);
            return true;
        } catch (error: unknown) {
            if (error instanceof Error) {
                console.error('Error checking session:', error);
                if (error.message.includes(`can't find session`)) {
                    return false;
                }
            }

            throw new Error(`Unexpected error while checking session: ${error}`);
        }
    }

    public printSessions(): void {
        for (const sess in this.currentSessions) {
            const currentSession = this.currentSessions[sess];
            let panesCount = 0
            let path = '';

            for (const window of currentSession.windows) {
                path = !path ? window.currentPath : path;

                panesCount += window.panes.length;
            }

            console.table({
                Name: sess,
                Path: path,
                Widnows: currentSession.windows.length,
                Panes: panesCount,
            })
        }
    }

    private formatPane(pane: string): Pane {
        const [index, currentCommand, currentPath, size] = pane.split(':');
        const [width, height] = size.split('x')

        const paneIndex = parseInt(index, 10);

        let splitDirection = PaneSplitDirection.Vertical;

        if (paneIndex > 0) {
            const parentIndex = Math.floor((paneIndex - 1) / 2);

            if (parentIndex % 2 === 0) {
                splitDirection = PaneSplitDirection.Horizontal;
            }
        }

        return {
            splitDirection,
            currentCommand,
            currentPath,
            width,
            height,
        };
    }


    private formatWindow(window: string): Window {
        const [windowName, currentCommand, currentPath, size]= window.split(':');

        const dimensions = size.split('x');

        const width = dimensions[0];
        const height = dimensions[1];

        return {
            windowName,
            currentCommand,
            currentPath,
            width,
            height,
            panes: []
        }
    }
}
