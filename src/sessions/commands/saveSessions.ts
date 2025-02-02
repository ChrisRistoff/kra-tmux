import * as bash from '../../utils/bashHelper';
import * as nvim from '../../utils/neovimHelper';
import * as fs from 'fs/promises';
import * as generalUI from '../../UI/generalUI';
import { sessionFilesFolder } from '../../filePaths';
import { getCurrentSessions, getDateString } from '../utils/sessionUtils';
import { TmuxSessions } from '../types/sessionTypes';

async function getFileNameFromUser(): Promise<string> {
    let branchName: string;

    try {
        branchName = (await bash.execCommand('git rev-parse --abbrev-ref HEAD')).stdout.split('\n')[0];
    } catch (_error) {
        branchName = '';
    }

    if (!branchName) {
        return await generalUI.askUserForInput('Please write a name for save: ');
    }

    const message = `Would you like to use ${branchName} as part of your name for your save?`;
    const shouldSaveBranchNameAsFileName = await generalUI.promptUserYesOrNo(message);

    const itemsArray = await fs.readdir(sessionFilesFolder);

    if (!shouldSaveBranchNameAsFileName) {
        return await generalUI.searchAndSelect({
            prompt: 'Please write a name for save: ',
            itemsArray,
        }) ?? '';
    }

    console.log(`Please write a name for your save, it will look like this: ${branchName}-<your-input>`);
    const sessionName = await generalUI.searchAndSelect({
        prompt: 'Please write a name for save: ',
        itemsArray,
    });

    return `${branchName}-${sessionName}-${getDateString()}`;
}

async function saveNeovimSessions(sessions: TmuxSessions, fileName: string): Promise<void> {
    for (const [sessionName, session] of Object.entries(sessions)) {
        for (const [windowIndex, window] of session.windows.entries()) {
            for (const [paneIndex, pane] of window.panes.entries()) {
                if (pane.currentCommand === 'nvim') {
                    await nvim.saveNvimSession(fileName, sessionName, windowIndex, paneIndex);
                }
            }
        }
    }
}

export async function saveSessionsToFile(): Promise<void> {
    const currentSessions = await getCurrentSessions();
    const sessionString = JSON.stringify(currentSessions, null, 2);

    if (sessionString === '{}') {
        console.log('No sessions found to save!');
        return;
    }

    const fileName = await getFileNameFromUser();
    await saveNeovimSessions(currentSessions, fileName);

    const filePath = `${sessionFilesFolder}/${fileName}`;
    await fs.writeFile(filePath, sessionString, 'utf-8');
    console.log('Save Successful!');
}
