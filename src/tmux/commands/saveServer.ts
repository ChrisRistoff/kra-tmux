import * as fs from 'fs/promises';
import * as bash from '@/utils/bashHelper';
import * as generalUI from '@/UI/generalUI';
import { serverFilesFolder } from '@/filePaths';
import { getCurrentSessions, getDateString } from '@/tmux/utils/sessionUtils';
import { filterGitKeep } from '@/utils/common';
import { updateCurrentSession } from '@/tmux/utils/common';
import { saveNvimForSessions, cleanUpStaleNvimSaves } from '@/tmux/utils/nvimSaveSync';

export async function quickSaveServer(fileName: string): Promise<void> {
    const currentSessions = await getCurrentSessions();
    const sessionString = JSON.stringify(currentSessions, null, 2);

    if (sessionString === '{}') {
        return;
    }

    const filePath = `${serverFilesFolder}/${fileName}`;
    await fs.writeFile(filePath, sessionString, 'utf-8');
}

export async function saveServerToFile(): Promise<void> {
    const currentSessions = await getCurrentSessions();
    const sessionString = JSON.stringify(currentSessions, null, 2);

    if (sessionString === '{}') {
        console.log('No sessions found to save!');

        return;
    }

    const fileName = await getFileNameFromUser();

    if (!fileName) {
        console.log('Save cancelled.');

        return;
    }

    await saveNvimForSessions(currentSessions, fileName);

    const filePath = `${serverFilesFolder}/${fileName}`;
    await fs.writeFile(filePath, sessionString, 'utf-8');

    cleanUpStaleNvimSaves(currentSessions);

    await updateCurrentSession(fileName);

    console.log('Save Successful!');
}

async function getFileNameFromUser(): Promise<string> {
    let branchName: string;

    try {
        branchName = (await bash.execCommand('git rev-parse --abbrev-ref HEAD')).stdout.split('\n')[0];
    } catch (_error) {
        branchName = '';
    }

    const itemsArray = filterGitKeep(await fs.readdir(serverFilesFolder));

    if (!branchName) {
        return await generalUI.searchAndSelect({
            itemsArray,
            prompt: 'Please write a name for save: ',
        });
    }

    const message = `Would you like to use ${branchName} as part of your name for your save?`;
    const shouldSaveBranchNameAsFileName = await generalUI.promptUserYesOrNo(message);

    if (!shouldSaveBranchNameAsFileName) {
        return await generalUI.searchAndSelect({
            prompt: 'Please write a name for save: ',
            itemsArray,
        }) || '';
    }

    const sessionName = await generalUI.searchAndSelect({
        itemsArray,
        prompt: 'Please write a name for your save, it will look like this: ${branchName}-<your-input>: ',
    });

    return `${branchName}-${sessionName}-${getDateString()}`;
}
