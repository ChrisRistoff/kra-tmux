import { BaseGit } from "./BaseGit";
import * as bash from "../helpers/bashHelper";
import * as generalUI from "../UI/generalUI";

export class GitRestore extends BaseGit {
    constructor() {
        super();
    }

    public async restoreFile(): Promise<void> {
        const fileToRestore = await this.getFileToRestoreFromUser();

        if (!fileToRestore) {
            return;
        }

        if (fileToRestore === "All") {
            await bash.execCommand('git restore ./');
            return;
        }

        await bash.execCommand(`git restore ${fileToRestore}`);
    }

    public async getFileToRestoreFromUser(): Promise<string> {
        const itemsArray = await this.getModifiedFilesNamesArray();

        itemsArray.unshift('All');

        const options: generalUI.SearchOptions = {
            prompt: "Pick a file to restore: ",
            itemsArray,
        };

        const fileToRestore = await generalUI.searchSelectAndReturnFromArray(options);

        return fileToRestore!;
    }

    public async getModifiedFilesNamesArray(): Promise<string[]> {
        const files = await bash.execCommand("git status --porcelain | awk '/^[ MARC]/{print $2}'").then(std => std.stdout.split('\n'));

        if (files[files.length - 1] === '') {
            files.pop();
        }

        return files;
    }
}
