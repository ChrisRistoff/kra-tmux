import { LoadSessions } from "./LoadSessions";
import * as saveUI from '../UI/loadSessionsUI';
import * as generalUI from '../UI/generalUI';
import * as fs from 'fs/promises';
import { TmuxSessions } from "../types/SessionTypes";

export class ManageSavedSessions extends LoadSessions {
    constructor () {
        super();
    }

    public async deleteSession(): Promise<void> {
        const savedServers = await this.getSavedSessionsNames()

        const fileName = await saveUI.searchAndSelectSavedSessions(savedServers);
        const filePath = `${this.sessionsFilePath}/${fileName}`

        const sessions = await this.setSavedSessionsByFilePath(filePath);
        this.printTargetSessions(sessions);

        const willDelete = await generalUI.promptUserYesOrNo(`Are you sure you want to delete save ${fileName}`)

        if (willDelete) {
            await fs.rm(filePath);
        }
    }

    public async setSavedSessionsByFilePath(filePath: string): Promise<TmuxSessions> {
        const latestSessions = await fs.readFile(filePath);
        return JSON.parse(latestSessions.toString())
    }

    public printTargetSessions(sessions: TmuxSessions): void {
        for (const sess of Object.keys(sessions)) {
            const currentSession = sessions[sess];
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


}
