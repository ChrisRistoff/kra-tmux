import { LoadSessions } from "./LoadSessions";
import * as generalUI from '../UI/generalUI';
import * as fs from 'fs/promises';
import { TmuxSessions } from "../types/SessionTypes";
import { sessionFilesFolder } from '../filePaths';

export class ManageSavedSessions extends LoadSessions {
    constructor () {
        super();
    }

    public async deleteSession(): Promise<void> {
        const savedServers = await this.getSavedSessionsNames();

        const fileName = await generalUI.searchSelectAndReturnFromArray({
            prompt: "Please select a server from the list to delte",
            itemsArray: savedServers,
        });

        const filePath = `${sessionFilesFolder}/${fileName}`;

        const sessions = await this.getSavedSessionsByFilePath(filePath);
        this.printTargetSessions(sessions);

        const willDelete = await generalUI.promptUserYesOrNo(`Are you sure you want to delete save ${fileName}`);

        if (willDelete) {
            await fs.rm(filePath);
        }
    }

    public async getSavedSessionsByFilePath(filePath: string): Promise<TmuxSessions> {
        const latestSessions = await fs.readFile(filePath);
        return JSON.parse(latestSessions.toString());
    }

    public printTargetSessions(sessions: TmuxSessions): void {
        for (const sess of Object.keys(sessions)) {
            const currentSession = sessions[sess];
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
}
