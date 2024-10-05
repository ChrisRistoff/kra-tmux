import * as bash from 'child_process';
import * as fs from 'fs/promises';
import { BaseSessions } from './BaseSession';
import { SessionEvent } from './events/SessionEvents';
import { PaneSplitDirection, TmuxSessions } from './types/SessionTypes';

class LoadSessions extends BaseSessions {
    public backupFile: string;
    public savedSessions: TmuxSessions;

    constructor () {
        super()
        this.backupFile = 'tmux_session_backup.txt';
        this.savedSessions = {};

        this.events.addAsyncEventListener(SessionEvent.OnSessionsRequest, async () => {
            this.getCurrentSessions();
            this.getSessionsFromSaved();
        })
    }

    public async getSortedSessionDates(): Promise<string[]> {
        const sessionsDates = await fs.readdir(this.sessionsFilePath);


        sessionsDates.sort((a, b) => {
            return new Date(b).getTime() - new Date(a).getTime()
        })

        return sessionsDates;
    }

    public async getSessionsFromSaved(): Promise<void> {
        const sessionDates = await this.getSortedSessionDates();
        const filePath = `${this.sessionsFilePath}/${sessionDates[0]}`

        const latestSessions = await fs.readFile(filePath);

        this.savedSessions = JSON.parse(latestSessions.toString())
    }

    public printSavedSessions(): void {
        for (const sess in this.savedSessions) {
            const currentSession = this.savedSessions[sess];
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

    public async loadLatestSession(): Promise<void> {
        await this.getSessionsFromSaved();

        for (const sess in this.savedSessions) {
            this.createTmuxSession(sess)
        }
    }

    public createTmuxSession(sessionName: string): void {
        const sourceTmux = 'tmux source ~/.tmux/.tmux.conf';
        bash.execSync(sourceTmux);

        bash.execSync(`tmux new-session -d -s ${sessionName}`);

        // Loop through each window starting from the second window
        this.savedSessions[sessionName].windows.forEach((window, windowIndex) => {
            bash.execSync(`tmux new-window -t ${sessionName} -n ${window.windowName} -c ${window.currentPath}`);

            // Loop through each pane in the window
            window.panes.forEach((pane, paneIndex) => {
                let direction;
                if (pane.splitDirection === PaneSplitDirection.Vertical) {
                    direction = 'v';
                } else {
                    direction = 'h';
                }

                if (paneIndex > 0) {
                    bash.execSync(`tmux split-window -t ${sessionName}:${windowIndex} -${direction} -c ${pane.currentPath}`);
                }

                if (pane.currentCommand) {
                    bash.execSync(`tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} '${pane.currentCommand}' C-m`);
                }

                bash.execSync(`tmux resize-pane -t ${sessionName}:${windowIndex}.${paneIndex} -x ${pane.width} -y ${pane.height}`);
            });

            // set layout after all panes are created
            bash.execSync(`tmux select-layout -t ${sessionName}:${windowIndex} tiled`);
        });
    }

    public async main (): Promise<void> {
        this.printSavedSessions();
        await this.loadLatestSession();
    }
}

const loading = new LoadSessions();
loading.events.emit(SessionEvent.OnSessionsRequest);
loading.main();
