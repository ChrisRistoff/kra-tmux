import * as bash from 'child_process';
import * as fs from 'fs/promises';
import { BaseSessions } from './BaseSession';
import { SessionEvent } from './events/SessionEvents';
import { TmuxSessions } from './types/SessionTypes';

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

        const createSession = `tmux new-session -d -s ${sessionName}`
        bash.execSync(createSession);

        this.savedSessions[sessionName].windows.forEach((window, windowIndex) => {

            const createWindow = `tmux new-window -t ${sessionName} -n ${window.windowName} -c ${window.currentPath}`
            bash.execSync(createWindow);

            window.panes.forEach((pane, paneIndex) => {
                if (paneIndex > 0) {
                    const createPane = `tmux split-window -t ${sessionName}:${windowIndex} -${pane.splitDirection} -c ${pane.currentPath}`
                    bash.execSync(createPane);
                }

                if (pane.currentCommand) {
                    bash.execSync(`tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} '${pane.currentCommand}' C-m`);
                }

                const resizePane = `tmux resize-pane -t ${sessionName}:${windowIndex}.${paneIndex} -x ${pane.width} -y ${pane.height}`
                bash.execSync(resizePane);
            });

            // set layout after all panes are created until I find a solution for the positions and sizes
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
