import * as bash from '../helpers/bashHelper';
import * as generalUI from '../UI/generalUI';
import * as fs from 'fs/promises';
import * as nvim from '../helpers/neovimHelper'
import { BaseSessions } from './BaseSession';
import { Pane, TmuxSessions } from '../types/SessionTypes';
import { Save } from '../Sessions/SaveSessions';
import { Settings } from '../types/SettingsTyeps';

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
        const itemsArray = await this.getSavedSessionsNames();

        const fileName = await generalUI.searchSelectAndReturnFromArray({
            itemsArray,
            prompt: "Select a session to load from the list:",
        });

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
            await this.getSessionsFromSaved();

            if (!this.savedSessions || Object.keys(this.savedSessions).length === 0) {
                console.error('No saved sessions found.');

                return;
            }

            for (const sess of Object.keys(this.savedSessions)) {
                await this.createTmuxSession(sess);
            }

            await this.sourceTmuxConfig();

            const firstSession = Object.keys(this.savedSessions)[0];
            await this.attachToSession(firstSession);
        } catch (error) {
            console.error('Error in loadLatestSession:', error);
        }
    }

    public async handleSessionsIfServerIsRunning(): Promise<void> {
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
            await this.setTimeout(200);
        }

        if (serverIsRunning && !shouldSaveCurrentSessions) {
            await this.killTmuxServer();
            await this.setTimeout(200);
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

            const applyLayout = `tmux select-layout -t ${sessionName}:${windowIndex} "${window.layout}"`;
            await bash.execCommand(applyLayout);

            await bash.execCommand(`tmux select-pane -t ${sessionName}:${windowIndex}.0`);

            const settings: Settings = await this.getSettings();

            if (settings.work && window.windowName === settings.workWindowNameForWatch) {
                await bash.sendKeysToTmuxTargetSession({
                    sessionName,
                    windowIndex,
                    paneIndex: 0,
                    command: settings.workCommandForWatch,
                })

            } else if (!settings.work && window.windowName === settings.personalWindowNameForWatch) {
                await bash.sendKeysToTmuxTargetSession({
                    sessionName,
                    windowIndex,
                    paneIndex: 0,
                    command: settings.personalCommandForWatch,
                })
            }

        }

        bash.execCommand('tmux select-window -t 0');

        const firstWindowName = this.savedSessions[sessionName].windows[0].windowName;
        const renameFirstWindow = `tmux rename-window -t ${sessionName}:0 ${firstWindowName}`;
        await bash.execCommand(renameFirstWindow);
    }

    private async navigateToFolder(pane: Pane, paneIndex: number): Promise<void> {
        const pathArray = pane.currentPath.split('/');

        await bash.sendKeysToTmuxTargetSession({
            paneIndex: paneIndex,
            command: 'cd'
        })

        for (let i = 3; i < pathArray.length; i++) {
            const folderPath = pathArray[i];
            console.log(`Checking existence of directory: ${folderPath}`);

            try {
                await bash.sendKeysToTmuxTargetSession({
                    paneIndex,
                    command: `[ -d '${folderPath}' ] && echo 'Directory exists' || (git clone ${pane.gitRepoLink} ${folderPath})`,
                })
                await bash.sendKeysToTmuxTargetSession({
                    paneIndex,
                    command: `cd ${folderPath} && echo 'Navigated to ${folderPath}'`,
                })
                console.log(`Directory ${folderPath} exists`);
            } catch (error) {
                console.error(`Error while checking or navigating: ${error}`);
            }
        }
    }
}
