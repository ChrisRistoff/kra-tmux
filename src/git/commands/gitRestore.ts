import * as bash from "../../helpers/bashHelper";
import * as ui from "../../UI/generalUI";
import { SearchOptions } from "../types/gitTypes";
import { getModifiedFiles } from "../utils/gitFileUtils";

async function getFileToRestoreFromUser(): Promise<string> {
    const itemsArray = await getModifiedFiles();
    itemsArray.unshift('All');

    const options: SearchOptions = {
        prompt: "Pick a file to restore: ",
        itemsArray,
    };

    return await ui.searchSelectAndReturnFromArray(options) ?? '';
}

export async function restoreFile(): Promise<void> {
    const fileToRestore = await getFileToRestoreFromUser();

    if (!fileToRestore) {
        return;
    }

    if (fileToRestore === "All") {
        await bash.execCommand('git restore ./');
        return;
    }

    await bash.execCommand(`git restore ${fileToRestore}`);
}
