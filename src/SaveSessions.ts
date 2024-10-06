import * as bash from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BaseSessions } from './BaseSession';

export class Save extends BaseSessions {

    constructor () {
        super()
    }

    public async saveSessionsToFile(): Promise<void> {
        const sessionString = JSON.stringify(this.currentSessions, null, 2);
        const dateArray = new Date().toString().split(' ');

        let timeArray = dateArray[4].split(':')
        timeArray.pop();
        const timeString = timeArray.join(':')

        const yearMonthDayTime = [dateArray[3], dateArray[1], dateArray[2], timeString]
        const fileName = yearMonthDayTime.join('-')
        const filePath = path.join(os.homedir(), `.tmux/sessions/${fileName}`);

        bash.exec(`if [ ! "~/.tmux/sessions" ]; then
                    mkdir "~/.tmux/sessions"
                fi
        `);

        await fs.writeFile(filePath, sessionString, 'utf-8');

        console.log('Save Successful!');
    }
}

const save = new Save();

save.setCurrentSessions();
save.printSessions();
save.saveSessionsToFile();
