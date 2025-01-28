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

    public async hardResetCurrentBranch(): Promise<void> {
        const currentBranch = await this.getCurrentBranch();
        await bash.execCommand('git fetch --prune');

        await bash.execCommand(`git reset --hard origin/${currentBranch}`);
    }

    public async getGitLog(): Promise<void> {
        const tmpfile = '/tmp/git-log-XXXXXX.txt';

        const command = `
                git log --graph --abbrev-commit --oneline --decorate --color=always \
                --pretty=format:'%C(yellow)%h%C(reset) %C(green)(%d)%C(reset) %C(blue)%s%C(reset) %C(red)%an%C(reset) %C(magenta)%ar%C(reset) %C(cyan)%d%C(reset) %C(white)%B%C(reset)' \
                | sed -E 's/\x1B\[[0-9;]*m//g' | sed 's/\|/   /g;s/[[:space:]]+$//;s/^    $//' > ${tmpfile}
            `

        try {
            await bash.execCommand(command);

            await bash.sendKeysToTmuxTargetSession({
                command: `nvim -c 'set filetype=git' ${tmpfile}`,
            });
        } catch (error) {
            console.error('Failed to run git log or open nvim:', error);
        }
    }
}
