import * as bash from "../../utils/bashHelper";
import { GIT_COMMANDS } from "../config/gitConstants";

export async function getCurrentBranch(): Promise<string> {
    const response = await bash.execCommand(GIT_COMMANDS.GET_BRANCH);
    return response.stdout.split('\n')[0];
}

export async function getTopLevelPath(): Promise<string> {
    const response = await bash.execCommand(GIT_COMMANDS.GET_TOP_LEVEL);
    return response.stdout.split('\n')[0];
}

export async function hardReset(): Promise<void> {
    try {
        const currentBranch = await getCurrentBranch();

        const beforeFetch = await bash.execCommand(GIT_COMMANDS.GET_REMOTE_BRANCHES);
        await bash.execCommand('git fetch --prune');
        const afterFetch = await bash.execCommand(GIT_COMMANDS.GET_REMOTE_BRANCHES);

        const beforeBranches = beforeFetch.stdout.split('\n').filter(Boolean);
        const afterBranches = afterFetch.stdout.split('\n').filter(Boolean);

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
        console.error("Failed to reset branch:", error);
    }
}

export async function getGitLog(): Promise<void> {
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
