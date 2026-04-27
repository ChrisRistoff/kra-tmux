import * as bash from "@/utils/bashHelper";
import * as ui from '@/UI/generalUI';
import { menuChain } from '@/UI/menuChain';

const currentBranch = 'current';

export async function createBranch() {
    const branchList = await bash.execCommand('git branch');
    const branchArray = branchList.stdout.trim().split('\n').map((branch) => {
        if (branch.startsWith('*')) {
            return currentBranch;
        }

        return branch.trim();
    });

    const { chosenBranch, branchName } = await menuChain()
        .step('chosenBranch', async () => ui.searchSelectAndReturnFromArray({
            itemsArray: branchArray,
            prompt: 'Select a branch to create your new branch off.',
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
