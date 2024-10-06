import * as bash from '../helpers/bashHelper'
import * as fs from 'fs/promises';
import { BaseSessions } from './BaseSession';
import { TmuxSessions } from '../types/SessionTypes';

export class LoadSessions extends BaseSessions {
    public backupFile: string;
    public savedSessions: TmuxSessions;

    constructor () {
        super()
        this.backupFile = 'tmux_session_backup.txt';
        this.savedSessions = {};
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
        for (const sess in Object.keys(this.savedSessions)) {
            const currentSession = this.savedSessions[sess];
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

    public async loadLatestSession(): Promise<void> {
        try {
            await this.spawnATempSession();
            await this.sourceTmuxConfig();
            await this.getSessionsFromSaved();

            if (!this.savedSessions || Object.keys(this.savedSessions).length === 0) {
                console.error('No saved sessions found.');
                await this.killTempSession();

                return;
            }

            for (const sess of Object.keys(this.savedSessions)) {
                if (await this.checkTmuxSessionExists(sess)) {
                    console.log(`Session ${sess} already exists`);
                } else {
                    console.log(`Creating tmux session: ${sess}`);
                    await this.createTmuxSession(sess);
                }
            }

            await this.killTempSession();

            // NOTE: Object doesnt guarantee order so probably a good idea to use an array
            const firstSession = Object.keys(this.savedSessions)[0];
            await this.attachToSession(firstSession);

        } catch (error) {
            console.error('Error in loadLatestSession:', error);
        }
    }

    public async createTmuxSession(sessionName: string): Promise<void> {
        const createSession = `tmux new-session -d -s ${sessionName}`
        await bash.execCommand(createSession);

        this.savedSessions[sessionName].windows.forEach(async (window, windowIndex) => {

            const createWindow = `tmux new-window -t ${sessionName} -n ${window.windowName} -c ${window.currentPath}`
            await bash.execCommand(createWindow);

            window.panes.forEach(async (pane, paneIndex) => {
                if (paneIndex > 0) {
                    const createPane = `tmux split-window -t ${sessionName}:${windowIndex} -c ${pane.currentPath}`
                    await bash.execCommand(createPane);
                }

                if (pane.currentCommand) {
                    await bash.execCommand(`tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} '${pane.currentCommand}' C-m`);
                }

                const resizePane = `tmux resize-pane -t ${sessionName}:${windowIndex}.${paneIndex} -x ${pane.width} -y ${pane.height}`
                await bash.execCommand(resizePane);
            });

            // NOTE: set layout after all panes are created until I find a solution for the positions and sizes
            await bash.execCommand(`tmux select-layout -t ${sessionName}:${windowIndex} tiled`);
        });
    }
}
