import * as bash from "@/utils/bashHelper";
import * as ui from '@/UI/generalUI';
import { platform } from 'os';
import { getModifiedFiles, getUntrackedFiles } from "@/git/utils/gitFileUtils";
import { menuChain } from '@/UI/menuChain';

export async function checkoutBranch() {
    const { selectedBranch } = await menuChain()
        .step('days', async () => ui.askUserForInput('How many days ago'))
        .step('selectedBranch', async (d) => {
            const daysNum = Number(d.days);
            const date = platform() === 'darwin'
                ? `date -v-${daysNum}d +%s`
                : `date -d '${daysNum} days ago' +%s`;

            const command = `git for-each-ref --format='%(refname:short) %(committerdate:unix) %(contents:subject)' refs/heads/ |
        awk -v cutoff=$(${date}) '$2 >= cutoff'`;

            const branchList = await bash.execCommand(command).then((res) => res.stdout.trim().split('\n').map((item) => {
                const splitItem = item.split(' ');
                splitItem[0] += ':';

                return splitItem.join(' ');
            }));

            return ui.searchSelectAndReturnFromArray({
                itemsArray: branchList,
                prompt: 'Select a branch to checkout to:',
            });
        })
        .run();

    const branchToCheckoutTo = (selectedBranch).split(':')[0];

    const modifiedFiles = [...await getModifiedFiles(), ...await getUntrackedFiles()];

    if (modifiedFiles.length > 0) {
        await handleModifiedFiles(branchToCheckoutTo);
    }

    await bash.execCommand(`git checkout ${branchToCheckoutTo}`);
}

async function handleModifiedFiles(branchName: string): Promise<void> {
    const { stashChanges, stashMessage } = await menuChain()
        .step('stashChanges', async () => ui.promptUserYesOrNo(`Do you want to stash changes before you checkout to ${branchName}`))
        .step('stashMessage', async (d) => (d.stashChanges)
            ? ui.askUserForInput('Write stash message: ')
            : Promise.resolve('')
        )
        .run();

    if (stashChanges) {
        await bash.execCommand(`git stash --include-untracked -m "${stashMessage}"`);
    }
}
