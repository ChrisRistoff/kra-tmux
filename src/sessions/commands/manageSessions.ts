import * as generalUI from '@UI/generalUI';
import * as fs from 'fs/promises';
import { sessionFilesFolder } from '@filePaths';
import { getSavedSessionsNames, getSavedSessionsByFilePath } from '@sessions/utils/sessionUtils';
import { printSessions } from '@sessions/commands/printSessions';

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

    printSessions(sessions);

    const willDelete = await generalUI.promptUserYesOrNo(
        `Are you sure you want to delete save ${fileName}`
    );

    if (willDelete) {
        await fs.rm(filePath);
        console.log(`Deleted session save: ${fileName}`);
    }
}
