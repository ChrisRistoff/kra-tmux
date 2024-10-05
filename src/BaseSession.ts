import * as bash from 'child_process';
import { TmuxSessions, Window, Pane } from './types/SessionTypes';
import { Base } from './Base';
import { PaneSplitDirection } from './enums/SessionEnums';

export class BaseSessions extends Base {
    public currentSessions: TmuxSessions;

    constructor () {
        super()
        this.currentSessions = {};
    }

    public getCurrentSessions(): void {
        const output = bash.execSync(`tmux list-sessions -F '#S'`);
        const sessions = output.toString().trim().split('\n');

        for (const session of sessions) {
            const windows = bash.execSync(`tmux list-windows -t ${session} -F "#{window_index}:#{window_name}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`).toString().trim().split('\n');

            for (let i = 0; i < windows.length; i++) {
                const window = this.formatWindow(windows[i]);

                if (this.currentSessions[session]) {
                    this.currentSessions[session].windows.push(window);
                } else {
                    this.currentSessions[session] = {
                        windows: [window]
                    }
                }
            }

            for (let i = 0; i < windows.length; i++) {
                const windowIndex = i;
                const panes = bash.execSync(`tmux list-panes -t ${session}:${i} -F "#{pane_index}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`).toString().trim().split('\n');

                for (let i = 0; i < panes.length; i++) {
                    const pane = this.formatPane(panes[i])
                    this.currentSessions[session].windows[windowIndex].panes.push(pane);
                }

            }
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
        const splitWindow = window.split(':');

        const dimensions = splitWindow[4].split('x');

        const windowName = splitWindow[1];
        const currentCommand = splitWindow[2];
        const currentPath = splitWindow[3];
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

    public printSessions(): void {
        for (const sess in this.currentSessions) {
            const currentSession = this.currentSessions[sess];
            let panesCount = 0
            let path = '';

            for (let i = 0; i < currentSession.windows.length; i++) {
                const currentWindow = currentSession.windows[i];

                path = !path ? currentWindow.currentPath : path;

                panesCount += currentWindow.panes.length;
            }

            console.table({
                Name: sess,
                Path: path,
                Widnows: currentSession.windows.length,
                Panes: panesCount,
            })
        }
    }
}
