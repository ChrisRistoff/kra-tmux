import { Base } from "../Base";
import * as bash from "../helpers/bashHelper";

export class BaseGit extends Base {
    public gitFilesFolderPath: string;

    constructor() {
        super()

        this.gitFilesFolderPath = `${__dirname}/../../../git-files`;
    }

    public async getCurrentBranch(): Promise<string> {
        return await bash.execCommand('git rev-parse --abbrev-ref HEAD').then(res => res.stdout.split('\n')[0]);
    }

    public async getTopLevelPath(): Promise<string> {
        return await bash.execCommand('git rev-parse --show-toplevel').then(std => std.stdout.split('\n')[0]);
    }
}
