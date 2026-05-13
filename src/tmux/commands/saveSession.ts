import * as bash from '@/utils/bashHelper';
import * as generalUI from '@/UI/generalUI';
import { singleSessionFilesFolder } from '@/filePaths';
import { getCurrentSessions, getDateString } from '@/tmux/utils/sessionUtils';
import { TmuxSessions } from '@/types/sessionTypes';
import {
    listSavedNames,
    writeSavedFile,
    savedFileExists,
} from '@/tmux/utils/savedSessionsIO';
import { saveNvimForSessions } from '@/tmux/utils/nvimSaveSync';

async function getAttachedSessionName(): Promise<string> {
    try {
        const out = await bash.execCommand(`tmux display-message -p '#S'`);

        return out.stdout.toString().trim();
    } catch (_err) {
        return '';
    }
}

async function pickSessionName(currentSessions: TmuxSessions): Promise<string> {
    const names = Object.keys(currentSessions);

    if (names.length === 0) {
        return '';
    }

    if (names.length === 1) {
        return names[0];
    }

    const attached = await getAttachedSessionName();
    const ordered = attached && names.includes(attached)
        ? [attached, ...names.filter((n) => n !== attached)]
        : names;

    return await generalUI.searchSelectAndReturnFromArray({
        itemsArray: ordered,
        prompt: 'Pick a session to save: ',
    });
}

async function getFileNameFromUser(): Promise<string> {
    let branchName: string;

    try {
        branchName = (await bash.execCommand('git rev-parse --abbrev-ref HEAD')).stdout.split('\n')[0];
    } catch (_error) {
        branchName = '';
    }

    const itemsArray = await listSavedNames(singleSessionFilesFolder);

    if (!branchName) {
        return await generalUI.searchAndSelect({
            itemsArray,
            prompt: 'Please write a name for save: ',
        });
    }

    const message = `Would you like to use ${branchName} as part of your name for your save?`;
    const shouldUseBranch = await generalUI.promptUserYesOrNo(message);

    if (!shouldUseBranch) {
        return await generalUI.searchAndSelect({
            prompt: 'Please write a name for save: ',
            itemsArray,
        }) || '';
    }

    const userPart = await generalUI.searchAndSelect({
        itemsArray,
        prompt: 'Please write a name for your save, it will look like this: ${branchName}-<your-input>: ',
    });

    return `${branchName}-${userPart}-${getDateString()}`;
}

async function resolveFinalFileName(initial: string): Promise<string | null> {
    let fileName = initial;

    while (await savedFileExists(singleSessionFilesFolder, fileName)) {
        const choice = await generalUI.searchAndSelect({
            itemsArray: ['rename', 'overwrite', 'cancel'],
            prompt: `"${fileName}" already exists. (rename / overwrite / cancel): `,
        });
        const action = (choice || 'cancel').trim().toLowerCase();

        if (action === 'overwrite') {
            return fileName;
        }

        if (action === 'rename') {
            fileName = await generalUI.askUserForInput('New name for the save: ');

            if (!fileName) {
                return null;
            }

            continue;
        }

        return null;
    }

    return fileName;
}

export async function saveSession(): Promise<void> {
    const currentSessions = await getCurrentSessions();

    if (Object.keys(currentSessions).length === 0) {
        console.log('No sessions found to save!');

        return;
    }

    const sessionName = await pickSessionName(currentSessions);

    if (!sessionName || !currentSessions[sessionName]) {
        console.log('Save cancelled.');

        return;
    }

    const initialName = await getFileNameFromUser();

    if (!initialName) {
        console.log('Save cancelled.');

        return;
    }

    const fileName = await resolveFinalFileName(initialName);

    if (!fileName) {
        console.log('Save cancelled.');

        return;
    }

    const singleSessionPayload: TmuxSessions = {
        [sessionName]: currentSessions[sessionName],
    };

    await saveNvimForSessions(singleSessionPayload, fileName);
    await writeSavedFile(singleSessionFilesFolder, fileName, singleSessionPayload);

    console.log(`Saved session "${sessionName}" -> ${fileName}`);
}
