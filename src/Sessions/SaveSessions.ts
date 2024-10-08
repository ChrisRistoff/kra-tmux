import * as fs from 'fs/promises';
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
        const filePath = `${__dirname}/../../../tmux-files/sessions/${fileName}`;

        await fs.writeFile(filePath, sessionString, 'utf-8');

        console.log('Save Successful!');
    }
}
