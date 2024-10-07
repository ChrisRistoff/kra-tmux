import * as bash from '../helpers/bashHelper'
import { Base } from '../Base';
import { TmuxSessions, Window, Pane } from '../types/SessionTypes';
import { PaneSplitDirection } from '../enums/SessionEnums';
import { format } from 'path';

export class BaseSessions extends Base {
    public currentSessions: TmuxSessions;

    constructor () {
        super()
        this.currentSessions = {};
    }

    public async setCurrentSessions(): Promise<void> {
        let output;
        try {
            output = await bash.execCommand(`tmux list-sessions -F '#S'`);
        } catch (error) {
            console.log('No active sessions found!')
            return;
        }

        const sessions = output.stdout.toString().trim().split('\n');

        for (const session of sessions) {
            const windows = await bash.execCommand(`tmux list-windows -t ${session} -F "#{window_index}:#{window_name}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`);
            const windowsArray = windows.stdout.toString().trim().split('\n');

            for (const window of windowsArray) {
                const formattedWindow = await this.formatWindow(window);

                if (this.currentSessions[session]) {
                    this.currentSessions[session].windows.push(formattedWindow);
                } else {
                    this.currentSessions[session] = {
                        windows: [formattedWindow]
                    }
                }
            }

            for (let i = 0; i < windowsArray.length; i++) {
                const windowIndex = i;
                const panes = await bash.execCommand(`tmux list-panes -t ${session}:${i} -F "#{pane_index}:#{pane_current_command}:#{pane_current_path}:#{pane_width}x#{pane_height}"`);
                const panesArray = panes.stdout.toString().trim().split('\n');

                for (let i = 0; i < panesArray.length; i++) {
                    const pane = this.formatPane(panesArray[i])
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

    public async attachToSession(session: string): Promise<void> {
        if (!this.checkTmuxSessionExists(session)) {
            console.log(`Session does not exist: ${session}`);
            return;
        }

        console.log(`Attaching to tmux session: ${session}`);
        await bash.runCommand('tmux', ['attach-session', '-t', session], {
            stdio: 'inherit',
            shell: true,
            env: { ...process.env, TMUX: '' },
        });
    }

    public async spawnATempSession(): Promise<void> {
        await bash.runCommand('tmux', ['new-session', '-d', '-s', 'myTempSession'], {
            stdio: 'inherit',
            shell: true,
            env: { ...process.env, TMUX: '' },
        });

        console.log('Temporary tmux session "myTempSession" created.');
    }

    public async killTempSession(): Promise<void> {
        if (await this.checkTmuxSessionExists('myTempSession')) {
            await bash.execCommand('tmux kill-session -t myTempSession');

            console.log('Killed temporary tmux session "myTempSession".');
        } else {
            console.log('Temporary tmux session "myTempSession" does not exist.');
        }
    }

    public async sourceTmuxConfig(): Promise<void> {
        const sourceTmux = 'tmux source ~/.tmux/.tmux.conf';
        await bash.execCommand(sourceTmux);
        console.log('Sourced tmux configuration file.');
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


    private async formatWindow(window: string): Promise<Window> {
        const [_windowIndex, windowName, currentCommand, currentPath, size] = window.split(':');

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
