import * as bash from '../helpers/bashHelper';
import * as ui from '../UI/loadSessionsUI';
import * as fs from 'fs/promises';
import * as nvim from '../helpers/neovimHelper'
import { BaseSessions } from './BaseSession';
import { Pane, TmuxSessions } from '../types/SessionTypes';
import { removeLastWindowTempHack } from '../removeLastWindowTempHack';

export class LoadSessions extends BaseSessions {
    public backupFile: string;
    public savedSessions: TmuxSessions;

    constructor () {
        super()
        this.backupFile = 'tmux_session_backup.txt';
        this.savedSessions = {};
    }

    public async getSessionsFromSaved(): Promise<void> {
        const fileName = await ui.searchAndSelectSavedSessions(await this.getSavedSessionsNames());

        const filePath = `${this.sessionsFilePath}/${fileName}`

        const latestSessions = await fs.readFile(filePath);

        this.savedSessions = JSON.parse(latestSessions.toString())
    }

    public async getSortedSessionDates(): Promise<string[]> {
        const sessionsDates = await fs.readdir(this.sessionsFilePath);

        sessionsDates.sort((a, b) => {
            return new Date(b).getTime() - new Date(a).getTime()
        })

        return sessionsDates;
    }

    public printSavedSessions(): void {
        for (const sess in Object.keys(this.savedSessions)) {
            const currentSession = this.savedSessions[sess];
            let panesCount = 0
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

    public async getSavedSessionsNames(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.sessionsFilePath);
            return files
        } catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
    }

    public async createTmuxSession(sessionName: string): Promise<void> {
        const createSession = `tmux new-session -d -s ${sessionName}`;
        await bash.execCommand(createSession);

        for (const [windowIndex, window] of this.savedSessions[sessionName].windows.entries()) {
            const createWindow = `tmux new-window -t ${sessionName} -n ${window.windowName} -c ~/`;
            await bash.execCommand(createWindow);

            // Pane creation and commands
            for (const [paneIndex, pane] of window.panes.entries()) {
                if (paneIndex > 0) {
                    const createPane = `tmux split-window -t ${sessionName}:${windowIndex} -c ~/`;
                    await bash.execCommand(createPane);
                }

                await this.navigateToFolder(pane, paneIndex);

                if (pane.currentCommand === "nvim") {
                    await nvim.loadNvimSession(sessionName, windowIndex, paneIndex);
                }

                const resizePane = `tmux resize-pane -t ${sessionName}:${windowIndex}.${paneIndex} -x ${pane.width} -y ${pane.height}`;
                await bash.execCommand(resizePane);
            }

            // NOTE: set layout after all panes are created until I find a solution for the positions and sizes
            await bash.execCommand(`tmux select-layout -t ${sessionName}:${windowIndex} tiled`);

        }

        await removeLastWindowTempHack(sessionName);
    }

    private async navigateToFolder(pane: Pane, paneIndex: number): Promise<void> {
        const pathArray = pane.currentPath.split('/');

        for (let i = 3; i < pathArray.length; i++) {
            const folderPath = pathArray[i];
            console.log(`Checking existence of directory: ${folderPath}`);

            const checkDirectory = `tmux send-keys -t ${paneIndex} "[ -d '${folderPath}' ] && echo 'Directory exists' || (echo 'Directory does not exist, cloning...' && git clone ${pane.gitRepoLink} ${folderPath})" C-m`;

            try {
                await bash.execCommand(checkDirectory);
                const navigateCommand = `tmux send-keys -t ${paneIndex} "cd ${folderPath} && echo 'Navigated to ${folderPath}'" C-m`;
                await bash.execCommand(navigateCommand);
                console.log(`Directory ${folderPath} exists`);
            } catch (error) {
                console.error(`Error while checking or navigating: ${error}`);
            }
        }
    }
}
