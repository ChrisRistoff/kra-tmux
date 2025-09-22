import * as generalUI from '@/UI/generalUI';
import * as fs from 'fs/promises';
import { sessionFilesFolder } from '@/filePaths';
import { getSavedSessionsNames, getSavedSessionsByFilePath } from '@/tmux/utils/sessionUtils';

/**
 * Deletes a saved server session after user confirmation.
 *
 * Prompts the user to select a session from the list of saved servers,
 * displays the selected sessions for verification, and requests confirmation
 * before permanently deleting the session file.
 */
export async function deleteSession(): Promise<void> {
    const savedServers = await getSavedSessionsNames();

    const fileName = await generalUI.searchSelectAndReturnFromArray({
        prompt: "Please select a server from the list to delete",
        itemsArray: savedServers,
    });

    if (!fileName) {
        return;
    }

    const filePath = `${sessionFilesFolder}/${fileName}`;
    const sessions = await getSavedSessionsByFilePath(filePath);

    let sessionDetails = '';
    for (const sess in sessions) {
        const currentSession = sessions[sess];
        let panesCount = 0;
        let path = '';

        for (const window of currentSession.windows) {
            path = path || window.currentPath;
            panesCount += window.panes.length;
        }
        sessionDetails += `  - Name: ${sess}, Path: ${path}, Windows: ${currentSession.windows.length}, Panes: ${panesCount}\n`;
    }

    if (sessionDetails === '') {
        sessionDetails = '  No sessions in this save.';
    }

    const willDelete = await generalUI.promptUserYesOrNo(
        `Are you sure you want to delete save ${fileName}?\n\nSessions in this save:\n${sessionDetails}`
    );

    if (willDelete) {
        await fs.rm(filePath);
        console.log(`Deleted session save: ${fileName}`);
    }
}
