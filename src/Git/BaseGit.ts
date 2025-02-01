import * as bash from "../helpers/bashHelper";

export class BaseGit {
    public async getCurrentBranch(): Promise<string> {
        const response = await bash.execCommand('git rev-parse --abbrev-ref HEAD');

        return response.stdout.split('\n')[0];
    }

    public async getTopLevelPath(): Promise<string> {
        const response = await bash.execCommand('git rev-parse --show-toplevel');

        return response.stdout.split('\n')[0];
    }

    public async hardResetCurrentBranch(): Promise<void> {
        try {
            const currentBranch = await this.getCurrentBranch();

            const beforeFetch = await bash.execCommand('git branch -r');
            await bash.execCommand('git fetch --prune');
            const afterFetch = await bash.execCommand('git branch -r');

            const beforeBranches = beforeFetch.stdout.split('\n');
            const afterBranches = afterFetch.stdout.split('\n');
            beforeBranches.pop();
            afterBranches.pop();

            const fetchedBranches = afterBranches.filter(branch => !beforeBranches.includes(branch));
            const prunedBranches = beforeBranches.filter(branch => !afterBranches.includes(branch));

            const reset = await bash.execCommand(`git reset --hard origin/${currentBranch}`);

            console.table({
                HEAD: reset.stdout,
                '': '=======================',
                'Fetched Branches': fetchedBranches,
                'Pruned Branches': prunedBranches
            });
        } catch (error) {
            console.error("General error:", error);
        }
    }

    public async getGitLog(): Promise<void> {
        const tmpfile = '/tmp/git-log-XXXXXX.txt';

        const command = `
                git log --graph --abbrev-commit --oneline --decorate --color=always \
                --pretty=format:'%C(yellow)%h%C(reset) %C(green)(%d)%C(reset) %C(blue)%s%C(reset) %C(red)%an%C(reset) %C(magenta)%ar%C(reset) %C(cyan)%d%C(reset) %C(white)%B%C(reset)' \
                | sed -E 's/\x1B\[[0-9;]*m//g' | sed 's/\|/   /g;s/[[:space:]]+$//;s/^    $//' > ${tmpfile}
            `;

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
