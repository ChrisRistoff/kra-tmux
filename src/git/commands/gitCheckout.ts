import * as bash from "@utils/bashHelper";
import * as ui from '@UI/generalUI';
import { platform } from 'os';
import { getModifiedFiles, getUntrackedFiles } from "../utils/gitFileUtils";

export async function checkoutBranch() {
    const days = Number(await ui.askUserForInput('How many days ago'));

    const date = platform() === 'darwin'
        ? `date -v-${days}d +%s`
        : `date -d '${days} days ago' +%s`;

    const command = `git for-each-ref --format='%(refname:short) %(committerdate:unix) %(contents:subject)' refs/heads/ |
        awk -v cutoff=$(${date}) '$2 >= cutoff'`;

    const branchList = await bash.execCommand(command).then((res) => res.stdout.trim().split('\n').map((item) => {
        const splitItem = item.split(' ');
        splitItem[0] += ':';

        return splitItem.join(' ');
    }));

    const selectedBranch = await ui.searchSelectAndReturnFromArray({
        itemsArray: branchList,
        prompt: 'Select a branch to checkout to:',
    })

    const branchToCheckoutTo = selectedBranch.split(':')[0];

    const modifiedFiles = [...await getModifiedFiles(), ...await getUntrackedFiles()]

    if (modifiedFiles.length > 0) {
        await handleModifiedFiles(branchToCheckoutTo);
    }

    await bash.execCommand(`git checkout ${branchToCheckoutTo}`);
}

async function handleModifiedFiles(branchName: string): Promise<void> {
    const stashChanges = await ui.promptUserYesOrNo(`Do you want to stash changes before you checkout to ${branchName}`);

    if (stashChanges) {
        const stashMessage = await ui.askUserForInput('Write stash message: ');
        await bash.execCommand(`git stash --include-untracked -m "${stashMessage}"`);
    }
}
