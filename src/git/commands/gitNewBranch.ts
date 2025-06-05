import * as bash from "@utils/bashHelper";
import * as ui from '@UI/generalUI';

export async function createBranch() {
    const branchList = await bash.execCommand('git branch');
    const branchArray = branchList.stdout.trim().split('\n').map((branch) => {
        if (branch.startsWith('*')) {
            return 'current';
        }

        return branch.trim();
    });

    const chosenBranchToCreateOff = await ui.searchSelectAndReturnFromArray({
        itemsArray: branchArray,
        prompt: 'Select a branch to create your new branch off.'
    })

    const nameForNewBranch = await ui.askUserForInput('Enter the name of new branch: ');

    if (chosenBranchToCreateOff !== 'current') {
        await bash.execCommand(`git checkout ${chosenBranchToCreateOff}`);
    }

    await bash.execCommand('kra git hard-reset');
    await bash.execCommand(`git branch ${nameForNewBranch}`);
    await bash.execCommand(`git checkout ${nameForNewBranch}`);
}
