import * as bash from "@/utils/bashHelper";
import * as ui from "@/UI/generalUI";
import { GitSearchOptions } from "@/types/gitTypes";
import { allFiles, getModifiedFiles } from "@/git/utils/gitFileUtils";

async function getFileToRestoreFromUser(): Promise<string> {
    const itemsArray = [allFiles, ...await getModifiedFiles()];

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

    if (fileToRestore === allFiles) {
        await bash.execCommand('git restore ./');

        return;
    }

    await bash.execCommand(`git restore ${fileToRestore}`);
}
