import { Base } from "../Base";
import * as bash from "../helpers/bashHelper";
import { gitFilesFolder } from "../filePaths";

export class BaseGit extends Base {
    constructor(
        public readonly gitFilesFolderPath = gitFilesFolder,
    ) {
        super();
    }

    public async getCurrentBranch(): Promise<string> {
        const response = await bash.execCommand('git rev-parse --abbrev-ref HEAD');

        return response.stdout.split('\n')[0];
    }

    public async getTopLevelPath(): Promise<string> {
        const response = await bash.execCommand('git rev-parse --show-toplevel');

        return response.stdout.split('\n')[0];
    }
}
