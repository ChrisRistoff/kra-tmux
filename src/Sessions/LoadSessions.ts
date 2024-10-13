import * as bash from '../helpers/bashHelper';
import * as generalUI from '../UI/generalUI';
import * as ui from '../UI/loadSessionsUI';
import * as fs from 'fs/promises';
import * as nvim from '../helpers/neovimHelper'
import { BaseSessions } from './BaseSession';
import { Pane, TmuxSessions } from '../types/SessionTypes';
import { Save } from '../Sessions/SaveSessions';

export class LoadSessions extends BaseSessions {
    public savedSessions: TmuxSessions;
    public saveSessionsObject: Save = new Save();
    private saveFileToLoadName: string;

    constructor () {
        super()
        this.savedSessions = {};
        this.saveFileToLoadName = '';
    }

    public async getSessionsFromSaved(): Promise<void> {
        const fileName = await ui.searchAndSelectSavedSessions(await this.getSavedSessionsNames());

        if (!fileName) {
            return;
        }

        const filePath = `${this.sessionsFilePath}/${fileName}`

        const latestSessions = await fs.readFile(filePath);

        this.saveFileToLoadName = fileName;
        this.savedSessions = JSON.parse(latestSessions.toString());
    }

    public printSavedSessions(): void {
        for (const sess in this.savedSessions) {
            const currentSession = this.savedSessions[sess];
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

            // NOTE: Object doesn't guarantee order so probably a good idea to use an array
            const firstSession = Object.keys(this.savedSessions)[0];
            await this.attachToSession(firstSession);
        } catch (error) {
            console.error('Error in loadLatestSession:', error);
        }
    }

    public async handleSessionIfAlreadyRunning(): Promise<void> {
        await this.setCurrentSessions();
        let shouldSaveCurrentSessions = false;
        let serverIsRunning = false;

        if (JSON.stringify(this.currentSessions) !== '{}') {
            this.printSessions();
            serverIsRunning = true;
            shouldSaveCurrentSessions = await generalUI.promptUserYesOrNo('Would you like to save currently running sessions?');
        }

        if (serverIsRunning && shouldSaveCurrentSessions) {
            await this.saveSessionsObject.saveSessionsToFile();
            await this.killTmuxServer();
            await this.debounce(200);
        }

        if (serverIsRunning && !shouldSaveCurrentSessions) {
            await this.killTmuxServer();
            await this.debounce(200);
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
            if (windowIndex > 0) {
                const createWindow = `tmux new-window -t ${sessionName} -n ${window.windowName} -c ~/`;
                await bash.execCommand(createWindow);
            }

            // Pane creation and commands
            for (const [paneIndex, pane] of window.panes.entries()) {
                if (paneIndex > 0) {
                    const createPane = `tmux split-window -t ${sessionName}:${windowIndex} -c ~/`;
                    await bash.execCommand(createPane);
                }

                await this.navigateToFolder(pane, paneIndex);

                if (pane.currentCommand === "nvim") {
                    await nvim.loadNvimSession(this.saveFileToLoadName, sessionName, windowIndex, paneIndex);
                }
            }

            const applyLayout = `tmux select-layout -t ${sessionName}:${windowIndex} ${window.layout}`;
            await bash.execCommand(applyLayout);

            await bash.execCommand(`tmux select-pane -t ${sessionName}:${windowIndex}.0`);
        }

        const firstWindowName = this.savedSessions[sessionName].windows[0].windowName;
        const renameFirstWindow = `tmux rename-window -t ${sessionName}:0 ${firstWindowName}`;
        await bash.execCommand(renameFirstWindow);
    }

    private async navigateToFolder(pane: Pane, paneIndex: number): Promise<void> {
        const pathArray = pane.currentPath.split('/');

        await bash.execCommand(`tmux send-keys -t ${paneIndex} "cd" C-m`)

        for (let i = 3; i < pathArray.length; i++) {
            const folderPath = pathArray[i];
            console.log(`Checking existence of directory: ${folderPath}`);

            const checkDirectory = `tmux send-keys -t ${paneIndex} "[ -d '${folderPath}' ] && echo 'Directory exists' || (git clone ${pane.gitRepoLink} ${folderPath})" C-m`;

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
