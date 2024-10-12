import * as bash from '../helpers/bashHelper';
import * as fs from 'fs/promises';
import { BaseSessions } from './BaseSession';
import * as generalUI from '../UI/generalUI';

export class Save extends BaseSessions {

    constructor () {
        super()
    }

    public async saveSessionsToFile(): Promise<void> {
        await this.setCurrentSessions();

        const sessionString = JSON.stringify(this.currentSessions, null, 2);

        if (sessionString === '{}') {
            console.log('No sessions found to save!');
            return;
        }

        const fileName = await this.getFileNameFromUser();

        const filePath = `${__dirname}/../../../tmux-files/sessions/${fileName}`;

        await fs.writeFile(filePath, sessionString, 'utf-8');

        console.log('Save Successful!');
    }

    public async getFileNameFromUser(): Promise<string> {
        let branchName : string;

        try {
            branchName = await bash.execCommand('git rev-parse --abbrev-ref HEAD').then(res => res.stdout);
        } catch (error) {
            branchName = '';
        }


        if (!branchName) {
            return await generalUI.askUserForInput('Please write a name for save: ');
        }

        branchName = branchName.split('\n')[0];
        const message = `Would you like to use ${branchName} as part of your name for your save?`;
        const shouldSaveBranchNameAsFileName = await generalUI.promptUserYesOrNo(message);

        const itemsArray = await fs.readdir(this.sessionsFilePath)

        const options: generalUI.SearchOptions = {
            prompt: 'Please write a name for your save: ',
            itemsArray,
        }

        if (!shouldSaveBranchNameAsFileName) {
            const sessionName = await generalUI.searchAndSelect(options);
            return sessionName!
        }


        const sessionName = await generalUI.searchAndSelect(options);

        const nameOfBranchOnOldSave = sessionName?.split('-')[0];

        if (nameOfBranchOnOldSave === branchName) {
            return sessionName!
        }

        if (!sessionName!) {
            return ''
        }

        return `${branchName}-${sessionName}`;
    }

    // NOTE: Unused, staying here for now until I decide if I will use a db and restructure
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
