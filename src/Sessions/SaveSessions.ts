import * as bash from '../helpers/bashHelper';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BaseSessions } from './BaseSession';

export class Save extends BaseSessions {

    constructor () {
        super()
    }

    public async saveSessionsToFile(): Promise<void> {
        this.setCurrentSessions();

        const sessionString = JSON.stringify(this.currentSessions, null, 2);

        if (sessionString === '{}') {
            console.log('No sessions found to save!');
            return;
        }

        const dateArray = new Date().toString().split(' ');

        let timeArray = dateArray[4].split(':')
        timeArray.pop();
        const timeString = timeArray.join(':')

        const yearMonthDayTime = [dateArray[3], dateArray[1], dateArray[2], timeString]
        const fileName = yearMonthDayTime.join('-')
        const filePath = path.join(os.homedir(), `.tmux/sessions/${fileName}`);

        await bash.execCommand(`if [ ! "~/.tmux/sessions" ]; then
                    mkdir "~/.tmux/sessions"
                fi
        `);

        await fs.writeFile(filePath, sessionString, 'utf-8');

        console.log('Save Successful!');
    }
}
