import * as bash from "@/utils/bashHelper";
import * as ui from '@/UI/generalUI';
import { menuChain } from '@/UI/menuChain';

const currentBranch = 'current';

export async function createBranch(): Promise<void> {
    const branchList = await bash.execCommand(
        "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/",
    );
    const currentRef = (await bash.execCommand('git rev-parse --abbrev-ref HEAD')).stdout.trim();
    const branchArray = branchList.stdout.trim().split('\n').filter(Boolean).map((branch) => {
        const name = branch.trim();
        if (name === currentRef) return currentBranch;

        return name;
    });

    const { chosenBranch, branchName } = await menuChain()
        .step('chosenBranch', async () => ui.searchSelectAndReturnFromArray({
            itemsArray: branchArray,
            prompt: 'Select a branch to base your new branch on',
            header: `${branchArray.length} local branch(es)`,
            details: async (item) => {
                const branch = item === currentBranch ? 'HEAD' : item;
                try {
                    const log = await bash.execCommand(
                        `git log --no-color --date=short --pretty=format:'%h %ad %an: %s' -n 20 ${branch}`,
                    );

                    return `branch: ${item}\n\n${log.stdout || '(no commits)'}`;
                } catch (e: unknown) {
                    return `Failed to load log: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        }))
        .step('branchName', async () => ui.askUserForInput('Enter the name of new branch: '))
        .run();

    if ((chosenBranch) !== currentBranch) {
        await bash.execCommand(`git checkout ${chosenBranch}`);
    }

    await bash.execCommand('kra git hard-reset');
    await bash.execCommand(`git branch ${branchName}`);
    await bash.execCommand(`git checkout ${branchName}`);
}
