import * as bash from '../helpers/bashHelper';
import * as fs from 'fs/promises';
import { BaseSessions } from './BaseSession';
import { askUserForFileName } from '../UI/saveSessionsUI';

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

        let branchName: string;

        try {
            branchName = await bash.execCommand('git rev-parse --abbrev-ref HEAD').then(res => res.stdout);
        } catch (error) {
            branchName = '';
        }

        const fileName = await askUserForFileName(branchName.split('\n')[0]);

        const filePath = `${__dirname}/../../../tmux-files/sessions/${fileName}`;

        await fs.writeFile(filePath, sessionString, 'utf-8');

        console.log('Save Successful!');
    }

    public getDateForFileName(): string {
        const dateArray = new Date().toString().split(' ');

        let timeArray = dateArray[4].split(':')
        timeArray.pop();
        const timeString = timeArray.join(':');
        const yearMonthDayTime = [dateArray[3], dateArray[1], dateArray[2], timeString]
        const fileName = yearMonthDayTime.join('-')

        return fileName;
    }
}
