import { LoadSessions } from "./LoadSessions";
import * as fs from 'fs/promises';

export class ManageSavedSessions extends LoadSessions {
    constructor () {
        super();
    }

    public async deleteLastSavedSession(): Promise<void> {
        const sessions = await this.getSortedSessionDates();
        const path = `${this.sessionsFilePath}/${sessions[0]}`

        await fs.rm(path);
        console.log(`session dated ${sessions[0]} was removed`)
    }

    public async main(): Promise<void> {
        this.deleteLastSavedSession();
    }
}
