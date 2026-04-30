import * as bash from "@/utils/bashHelper";
import { getStashes } from "@/git/utils/gitFileUtils";
import { UserCancelled } from '@/UI/menuChain';
import { pickList } from '@/UI/dashboard/pickList';
import { runInherit, browseFiles } from '@/UI/dashboard/screen';
import type * as blessed from 'blessed';

async function loadStashFiles(stashIdx: number): Promise<string[]> {
    try {
        const out = await bash.execCommand(`git stash show --name-only stash@{${stashIdx}}`);

        return out.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function vimEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/ /g, '\\ ').replace(/'/g, "\\'");
}

async function viewStashFileSplit(stashIdx: number, file: string, screen: blessed.Widgets.Screen): Promise<void> {
    const f = vimEscape(file);
    await runInherit('nvim', ['-c', `Gedit stash@{${stashIdx}}:${f}`, '-c', `Gvdiffsplit HEAD:${f}`], screen);
}

async function browseStashFiles(stashIdx: number, screen: blessed.Widgets.Screen): Promise<void> {
    const files = await loadStashFiles(stashIdx);
    await browseFiles(screen, {
        title: `stash@{${stashIdx}} files`,
        files,
        view: async (file) => viewStashFileSplit(stashIdx, file, screen),
    });
}

async function pickStash(stashList: string[], prompt: string, includeStop = false): Promise<string | null> {
    const items = includeStop ? ['stop', ...stashList] : stashList;
    const r = await pickList({
        title: prompt,
        header: `${stashList.length} stash(es)`,
        items,
        details: async (item) => {
            if (item === 'stop') return 'Exit the drop loop.';
            const idx = stashList.indexOf(item);
            if (idx < 0) return '';
            try {
                const files = await loadStashFiles(idx);
                const out = await bash.execCommand(`git stash show -p --no-color stash@{${idx}}`);

                return [
                    `# files (${files.length}):`,
                    ...files.map(f => `  ${f}`),
                    '',
                    '# stash diff:',
                    out.stdout || '(empty stash)',
                ].join('\n');
            } catch (e: unknown) {
                return `Failed to read stash: ${e instanceof Error ? e.message : String(e)}`;
            }
        },
        actions: [{
            id: 'split',
            keys: ['C-d'],
            label: 'ctrl-d browse files (split: stash vs HEAD)',
            run: async (item, screen) => {
                if (!item || item === 'stop') return;
                const idx = stashList.indexOf(item);
                if (idx < 0) return;
                await browseStashFiles(idx, screen);
            },
        }],
    });

    return r.value;
}

async function pickAction(prompt: string, choices: string[]): Promise<string | null> {
    const r = await pickList({
        title: prompt,
        header: prompt,
        items: choices,
        detailsUseTags: true,
        details: (item, index) => [
            `{cyan-fg}selected{/cyan-fg}  {bold}${item}{/bold}`,
            `{cyan-fg}position{/cyan-fg}  {yellow-fg}${index + 1}{/yellow-fg} / {white-fg}${choices.length}{/white-fg}`,
            '',
            item === 'apply'
                ? '{white-fg}Apply this stash onto the current working tree.{/white-fg}'
                : '{white-fg}Permanently remove this stash entry.{/white-fg}',
            '',
            '{gray-fg}enter{/gray-fg} confirm action',
            '{gray-fg}q{/gray-fg} cancel',
        ].join('\n'),
    });

    return r.value;
}

export async function applyOrDropStash(): Promise<void> {
    const stashList = await getStashes();
    while (true) {
        const stash = await pickStash(stashList, 'Pick a stash to apply or drop');
        if (stash === null) throw new UserCancelled();

        const action = await pickAction(`Apply or drop ${stash}?`, ['apply', 'drop']);
        if (action === null) continue;

        const command = `git stash ${action} stash@\{${stashList.indexOf(stash)}\}`;
        await bash.execCommand(command);
        console.log(`Stash ${action} complete for: ${stash}`);

        return;
    }
}

export async function dropMultipleStashes(): Promise<void> {
    while (true) {
        const stashList = await getStashes();
        if (stashList.length === 0) {
            console.log('No stashes left.');

            return;
        }
        const stash = await pickStash(stashList, 'Pick a stash to drop (stop to exit)', true);
        if (stash === null || stash === 'stop') return;

        const command = `git stash drop stash@\{${stashList.indexOf(stash)}\}`;
        await bash.execCommand(command);
        console.log(`Stash dropped: ${stash}`);
    }
}

