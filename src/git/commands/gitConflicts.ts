import * as bash from "../../helpers/bashHelper";
import * as vim from "../../helpers/neovimHelper";
import * as ui from "../../UI/generalUI";
import { getConflictedFiles } from "../utils/gitFileUtils";
import { Conflicts } from "../types/gitTypes";

export async function handleConflicts(): Promise<void> {
    const conflictsArray = await getConflictedFiles();
    const conflictedFilesSet = new Set(conflictsArray);

    if (!conflictsArray.length) {
        console.log('No Conflicts to Handle!');
        return;
    }

    while (conflictedFilesSet.size !== 0) {
        const fileName = await ui.searchSelectAndReturnFromArray({
            itemsArray: Array.from(conflictedFilesSet),
            prompt: 'Pick a file to resolve: '
        });

        await vim.openVim(fileName, ':Gvdiffsplit!');

        const conflicts = await bash.grepFileForString(fileName, `<<<<<<<|=======|>>>>>>>`);

        if (!conflicts) {
            conflictedFilesSet.delete(fileName);
        }
    }

    const conflictsObject: Conflicts = {};
    conflictsArray.forEach((conflict: string, index: number) => {
        conflictsObject[`${index + 1}.File Name`] = conflict;
    });

    console.table(conflictsObject);
}
