import * as bash from "@utils/bashHelper";
import * as ui from '@UI/generalUI';
import { platform } from 'os';

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

    await bash.execCommand(`git checkout ${branchToCheckoutTo}`);
}
