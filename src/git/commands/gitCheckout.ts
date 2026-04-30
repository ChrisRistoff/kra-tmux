import * as bash from "@/utils/bashHelper";
import * as ui from '@/UI/generalUI';
import { platform } from 'os';
import { getModifiedFiles, getUntrackedFiles } from "@/git/utils/gitFileUtils";
import { menuChain, UserCancelled } from '@/UI/menuChain';
import { escTag, pickList } from '@/UI/dashboard';

async function loadBranchesWithinDays(daysNum: number): Promise<string[]> {
    const date = platform() === 'darwin'
        ? `date -v-${daysNum}d +%s`
        : `date -d '${daysNum} days ago' +%s`;

    const command = `git for-each-ref --format='%(refname:short) %(committerdate:unix) %(contents:subject)' refs/heads/ |
awk -v cutoff=$(${date}) '$2 >= cutoff'`;

    const { stdout } = await bash.execCommand(command);

    return stdout.trim().split('\n').filter(Boolean).map((item) => {
        const splitItem = item.split(' ');
        splitItem[0] += ':';

        return splitItem.join(' ');
    });
}
function formatCheckoutLog(branch: string, currentBranch: string, rawLog: string): string {
    const lines = rawLog.trim().length > 0
        ? rawLog.trim().split('\n').map((line) => {
            const match = line.match(/^(\S+)\s+(\S+)\s+(.*)$/);
            if (!match) return `{white-fg}${escTag(line)}{/white-fg}`;

            const [, hash, date, summary] = match;

            return `{yellow-fg}${escTag(hash)}{/yellow-fg} {cyan-fg}${escTag(date)}{/cyan-fg} {white-fg}${escTag(summary)}{/white-fg}`;
        }).join('\n')
        : '{gray-fg}(no commits){/gray-fg}';

    const currentBadge = branch === currentBranch ? ' {green-fg}[current]{/green-fg}' : '';

    return [
        `{cyan-fg}branch{/cyan-fg} {bold}${escTag(branch)}{/bold}${currentBadge}`,
        '',
        lines,
    ].join('\n');
}

function formatCheckoutListItem(item: string, currentBranch: string): string {
    const branch = item.split(':')[0]?.trim() ?? item;
    const rest = item.slice(branch.length + 1).trim();
    const currentBadge = branch === currentBranch ? ' {green-fg}[current]{/green-fg}' : '';

    return [
        `{bold}${escTag(branch)}{/bold}${currentBadge}`,
        rest ? ` {gray-fg}${escTag(rest)}{/gray-fg}` : '',
    ].join('');
}

function formatCheckoutContext(
    branch: string,
    currentBranch: string,
    daysNum: number,
    branchCount: number,
    modifiedCount: number,
    untrackedCount: number,
): string {
    const workingTreeState = modifiedCount + untrackedCount > 0
        ? '{yellow-fg}dirty{/yellow-fg}'
        : '{green-fg}clean{/green-fg}';

    return [
        `{cyan-fg}selected{/cyan-fg}    {bold}${escTag(branch)}{/bold}`,
        `{cyan-fg}current{/cyan-fg}     {white-fg}${escTag(currentBranch || '(detached HEAD)')}{/white-fg}`,
        `{cyan-fg}window{/cyan-fg}      {yellow-fg}${daysNum} day(s){/yellow-fg}`,
        `{cyan-fg}branches{/cyan-fg}    {white-fg}${branchCount}{/white-fg}`,
        `{cyan-fg}workspace{/cyan-fg}   ${workingTreeState}`,
        `{cyan-fg}modified{/cyan-fg}    {yellow-fg}${modifiedCount}{/yellow-fg}`,
        `{cyan-fg}untracked{/cyan-fg}   {magenta-fg}${untrackedCount}{/magenta-fg}`,
        '',
        '{gray-fg}enter{/gray-fg} checkout branch',
        '{gray-fg}ctrl-d{/gray-fg} change lookback window',
        '{gray-fg}q{/gray-fg} cancel',
    ].join('\n');
}

export async function checkoutBranch(): Promise<void> {
    let daysNum = 7;

    const currentBranch = (await bash.execCommand('git branch --show-current')).stdout.trim();
    const modifiedCount = (await getModifiedFiles()).length;
    const untrackedCount = (await getUntrackedFiles()).length;

    let selectedBranch: string | null = null;
    while (selectedBranch === null) {
        const branchList = await loadBranchesWithinDays(daysNum);
        const items = branchList.length ? branchList : ['<no branches in window>'];

        const result = await pickList({
            title: 'Select a branch to checkout to',
            header: `Branches with commits in last ${daysNum} day(s) · ${branchList.length} branch(es)`,
            items,
            itemsUseTags: true,
            renderItem: (item) => item === '<no branches in window>'
                ? '{gray-fg}<no branches in window>{/gray-fg}'
                : formatCheckoutListItem(item, currentBranch),
            detailsUseTags: true,
            details: async (item) => {
                const branch = item.split(':')[0]?.trim();
                if (!branch || branch === '<no branches in window>') return '';
                try {
                    const log = await bash.execCommand(
                        `git log --no-color --date=short --pretty=format:'%h %ad %an: %s' -n 20 ${branch}`,
                    );

                    return formatCheckoutLog(branch, currentBranch, log.stdout);
                } catch (e: unknown) {
                    return `{red-fg}Failed to load log:{/red-fg} ${escTag(e instanceof Error ? e.message : String(e))}`;
                }
            },
            secondaryLabel: 'checkout context',
            secondaryDetailsUseTags: true,
            secondaryDetails: (item) => {
                const branch = item.split(':')[0]?.trim();
                if (!branch || branch === '<no branches in window>') return '';

                return formatCheckoutContext(
                    branch,
                    currentBranch,
                    daysNum,
                    branchList.length,
                    modifiedCount,
                    untrackedCount,
                );
            },
            actions: [{ id: 'days', keys: ['C-d'], label: 'ctrl-d change days' }],
        });

        if (result.action === 'days') {
            const next = Number(await ui.askUserForInput(`Days lookback (current ${daysNum})`));
            if (Number.isFinite(next) && next > 0) daysNum = next;
            continue;
        }
        if (result.value === null) throw new UserCancelled();
        if (result.value === '<no branches in window>') {
            throw new UserCancelled();
        }
        selectedBranch = result.value;
    }

    const branchToCheckoutTo = selectedBranch.split(':')[0];
    if (!branchToCheckoutTo) return;

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
