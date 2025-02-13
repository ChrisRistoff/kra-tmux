import * as bash from "@utils/bashHelper";
import * as ui from "@UI/generalUI";
import { GitSearchOptions } from "@customTypes/gitTypes";
import { getModifiedFiles } from "@git/utils/gitFileUtils";

async function getFileToRestoreFromUser(): Promise<string> {
    const itemsArray = await getModifiedFiles();
    itemsArray.unshift('All');

    const options: GitSearchOptions = {
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
