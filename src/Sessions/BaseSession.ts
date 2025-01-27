import * as bash from '../helpers/bashHelper';
import { Base } from '../Base';
import { TmuxSessions, Window, Pane } from '../types/SessionTypes';
import { sessionFilesFolder } from '../filePaths';

export class BaseSessions extends Base {
    public currentSessions: TmuxSessions;

    constructor (
        public readonly sessionsFilePath = sessionFilesFolder,
    ) {
        super();
        this.currentSessions = {};
    }

    public async setCurrentSessions(): Promise<void> {
        let output;
        try {
            output = await bash.execCommand(`tmux list-sessions -F '#S'`);
        } catch (_error) {
            console.log('No active sessions found!');
            return;
        }

        const sessions = output.stdout.toString().trim().split('\n');

        for (const session of sessions) {
            const windows = await bash.execCommand(`tmux list-windows -t ${session} -F "#{window_name}:#{pane_current_command}:#{pane_current_path}:#{window_layout}"`);
            const windowsArray = windows.stdout.toString().trim().split('\n');

            for (const window of windowsArray) {
                const formattedWindow = await this.formatWindow(window);

                if (this.currentSessions[session]) {
                    this.currentSessions[session].windows.push(formattedWindow);
                } else {
                    this.currentSessions[session] = {
                        windows: [formattedWindow]
                    };
                }
            }

            for (let i = 0; i < windowsArray.length; i++) {
                const windowIndex = i;
                let panes

                try {
                    panes = await bash.execCommand(`tmux list-panes -t ${session}:${i} -F "#{pane_current_command}:#{pane_current_path}:#{pane_left}x#{pane_top}"`);
                } catch(error) {
                    console.log(error);
                    console.log('Skipping window');

                    continue;
                }

                const panesArray = panes.stdout.toString().trim().split('\n');

                for (let i = 0; i < panesArray.length; i++) {
                    const pane = await this.formatPane(panesArray[i]);
                    this.currentSessions[session].windows[windowIndex].panes.push(pane);
                }
            }
        }
    }

    public async checkTmuxSessionExists(sessionName: string): Promise<boolean> {
        try {
            await bash.execCommand(`tmux has-session -t ${sessionName}`);
            return true;
        } catch (error) {
            if (error instanceof Error && error.message.includes(`can't find session`)) {
                return false;
            }

            throw new Error(`Unexpected error while checking session: ${error}`);
        }
    }

    public printSessions(): void {
        for (const sess in this.currentSessions) {
            const currentSession = this.currentSessions[sess];
            let panesCount = 0;
            let path = '';

            for (const window of currentSession.windows) {
                path = path || window.currentPath;
                panesCount += window.panes.length;
            }

            console.table({
                Name: sess,
                Path: path,
                Widnows: currentSession.windows.length,
                Panes: panesCount,
            });
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

    public async sourceTmuxConfig(): Promise<void> {
        const sourceTmux = `tmux source ${__dirname}/../../../tmux-files/.tmux.conf`;
        await bash.execCommand(sourceTmux);
        console.log('Sourced tmux configuration file.');
    }

    public async killTmuxServer(): Promise<void> {
        try {
            await bash.execCommand('tmux kill-server');
        } catch (_error) {
            console.log('No Server Running');
        }
    }

    public async detachSession(): Promise<void> {
        try {
            await bash.execCommand('tmux detach');
        } catch (_error) {
            console.log('failed to detach');
        }
    }

    private async formatPane(pane: string): Promise<Pane> {
        const [currentCommand, currentPath, paneLeft, paneTop] = pane.split(':');

        const gitRepoLink = await this.getGitRepoLink(currentPath);

        return {
            currentCommand,
            currentPath,
            gitRepoLink,
            paneLeft,
            paneTop,
        };
    }

    private async formatWindow(window: string): Promise<Window> {
        const [windowName, currentCommand, currentPath, layout] = window.split(':');

        const gitRepoLink = await this.getGitRepoLink(currentPath);

        return {
            windowName,
            layout,
            gitRepoLink,
            currentCommand,
            currentPath,
            panes: []
        };
    }

    private async getGitRepoLink(path: string): Promise<string | undefined> {
        let result = '';

        try {
            const stdout = await bash.execCommand(`git -C ${path} remote get-url origin`);
            result = stdout.stdout;
        } catch (_error) {
            return undefined;
        }

        const finalResult = result.split('\n');

        return finalResult[0];
    }
}
