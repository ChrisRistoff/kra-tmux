import { BaseGit } from "./BaseGit";
import * as bash from "../helpers/bashHelper";
import * as vim from "../helpers/neovimHelper";
import * as ui from "../UI/generalUI";

type Conflicts = {
    [key: string]: string,
}

export class GitConflict extends BaseGit {
    public async handleConflicts(): Promise<void> {
        const conflictsArray: string[] = await this.getConflictedFiles();
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

            await vim.openVim(fileName, ':Gdiffsplit');

            const conflicts = await bash.grepFileForString(fileName, `<<<<<<<|=======|>>>>>>>`);

            if (!conflicts) {
                conflictedFilesSet.delete(fileName);
            }
        }

        const conflictsObject: Conflicts = {};
        let fileCounter = 1;

        conflictsArray.forEach((conflict: string) => {
            conflictsObject[`${fileCounter}.File Name`] = conflict;
            fileCounter++;
        });

        console.table(conflictsObject);
    }

    private async getConflictedFiles(): Promise<string[]> {
        const conflictedFiles = await bash.execCommand('git diff --name-only --diff-filter=U');
        const conflictedFilesArray = conflictedFiles.stdout.split('\n');
        conflictedFilesArray.pop();

        return conflictedFilesArray;
    }
}
