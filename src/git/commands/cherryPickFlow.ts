import { spawn } from 'child_process';
import * as bash from '@/utils/bashHelper';
import { pickList } from '@/UI/dashboard';
import { withTempScreen, runInherit, pauseScreen } from '@/UI/dashboard/screen';

export interface CherryPickResult {
    outcome: 'applied' | 'aborted' | 'skipped' | 'cancelled' | 'failed' | 'in-progress';
    message: string;
}
interface CherryPickOption {
    id: 'apply' | 'edit' | 'x' | 'no-commit' | 'preview-commit' | 'preview-files' | 'cancel';
    label: string;
    args: string[];
    explain: string;
}

const MENU_OPTIONS: CherryPickOption[] = [
    {
        id: 'apply',
        label: 'Apply (default)',
        args: [],
        explain:
            '{bold}git cherry-pick <hash>{/bold}\n\n' +
            'Re-apply the diff of the highlighted commit on top of {cyan-fg}HEAD{/cyan-fg} and create a new commit\n' +
            'with the {bold}same author and original message{/bold} (committer becomes you).\n\n' +
            'On conflict: stops with files marked as conflicted; you stay in the resolver to fix\n' +
            'them, then choose {green-fg}continue{/green-fg} / {yellow-fg}skip{/yellow-fg} / {red-fg}abort{/red-fg}.',
    },
    {
        id: 'edit',
        label: 'Apply with --edit (edit commit message)',
        args: ['--edit'],
        explain:
            '{bold}git cherry-pick --edit <hash>{/bold}\n\n' +
            'Same as {cyan-fg}apply{/cyan-fg}, but opens {bold}$GIT_EDITOR{/bold} so you can rewrite the commit\n' +
            'message before the new commit is created. Useful when you want to add context\n' +
            'about why this commit was lifted onto another branch.',
    },
    {
        id: 'x',
        label: 'Apply with -x (record source commit hash)',
        args: ['-x'],
        explain:
            '{bold}git cherry-pick -x <hash>{/bold}\n\n' +
            'Same as {cyan-fg}apply{/cyan-fg}, but appends a line {bold}"(cherry picked from commit <hash>)"{/bold}\n' +
            'to the new commit message. The original SHA stays traceable in history, which is\n' +
            'the convention for backports / hotfix branches.',
    },
    {
        id: 'no-commit',
        label: 'Apply with --no-commit (stage only, do not commit)',
        args: ['--no-commit'],
        explain:
            '{bold}git cherry-pick --no-commit <hash>{/bold}\n\n' +
            'Apply the diff to the working tree and stage it, but {bold}do not create a commit{/bold}.\n' +
            'Use this to combine the change with other modifications, amend it, or split it\n' +
            'into multiple commits before committing yourself.',
    },
    {
        id: 'preview-commit',
        label: 'Preview commit (git show)',
        args: [],
        explain:
            '{bold}git show <hash> | less -R{/bold}\n\n' +
            'Open the full commit (metadata + diff) in {cyan-fg}less{/cyan-fg} so you can review what\n' +
            'the cherry-pick will actually change before applying. Pure read-only preview;\n' +
            'returns to this menu on quit.',
    },
    {
        id: 'preview-files',
        label: 'Preview changed files',
        args: [],
        explain:
            '{bold}git show --name-status <hash>{/bold}\n\n' +
            'List the files this commit touches with their status\n' +
            '({green-fg}A{/green-fg}=added, {yellow-fg}M{/yellow-fg}=modified, {red-fg}D{/red-fg}=deleted, {cyan-fg}R{/cyan-fg}=renamed). Pure preview; returns here.',
    },
    {
        id: 'cancel',
        label: 'Cancel',
        args: [],
        explain:
            '{red-fg}{bold}Do nothing{/bold}{/red-fg} and return to the log dashboard.\n\n' +
            'Equivalent to pressing {cyan-fg}q{/cyan-fg} or {cyan-fg}escape{/cyan-fg}.',
    },
];

async function isCherryPickInProgress(): Promise<boolean> {
    try {
        const { stdout: gd } = await bash.execCommand('git rev-parse --git-dir');
        const dir = gd.trim();
        const { stdout } = await bash.execCommand(`test -f ${dir}/CHERRY_PICK_HEAD && echo yes || echo no`);

        return stdout.trim() === 'yes';
    } catch {
        return false;
    }
}

async function getConflictedFiles(): Promise<string[]> {
    try {
        const { stdout } = await bash.execCommand('git diff --name-only --diff-filter=U');

        return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    } catch {
        return [];
    }
}

async function commitSummary(hash: string): Promise<string> {
    try {
        const { stdout } = await bash.execCommand(
            `git show --no-patch --format='%h %s%n%n  by %an <%ae>%n  %ar (%aI)' ${hash}`,
        );

        return stdout.trim();
    } catch (e) {
        return `Failed to load commit summary: ${(e as Error).message}`;
    }
}

async function changedFiles(hash: string): Promise<string[]> {
    try {
        const { stdout } = await bash.execCommand(`git show --name-status --format='' ${hash}`);

        return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    } catch {
        return [];
    }
}

async function runCherryPick(args: string[], hash: string): Promise<{ ok: boolean; stderr: string }> {
    try {
        const { stderr } = await bash.execCommand(`git cherry-pick ${args.join(' ')} ${hash}`.trim());

        return { ok: true, stderr };
    } catch (e) {
        return { ok: false, stderr: (e as Error).message };
    }
}

async function resolveConflicts(branch: string): Promise<CherryPickResult> {
    const seen = new Set<string>();
    for (;;) {
        if (!(await isCherryPickInProgress())) {
            return { outcome: 'applied', message: `cherry-pick on ${branch} completed during conflict resolution` };
        }
        const unresolved = await getConflictedFiles();
        unresolved.forEach((f) => seen.add(f));
        const sortedUnresolved = unresolved.slice().sort((a, b) => a.localeCompare(b));
        const sortedResolved = Array.from(seen).filter((f) => !unresolved.includes(f)).sort((a, b) => a.localeCompare(b));
        const orderedFiles = [...sortedUnresolved, ...sortedResolved];
        const items = orderedFiles.length > 0 ? orderedFiles : ['<no conflicts detected — choose an action below>'];
        const result = await pickList({
            title: `cherry-pick · resolve conflicts on ${branch}`,
            header: `${sortedUnresolved.length} unresolved · ${sortedResolved.length} resolved · enter=edit · c=continue · s=skip · a=abort`,
            items,
            itemsUseTags: true,
            renderItem: (item) => {
                if (!orderedFiles.includes(item)) return `{gray-fg}${item}{/gray-fg}`;
                const isResolved = !unresolved.includes(item);

                return isResolved
                    ? `{green-fg}\u2713{/green-fg} ${item}`
                    : `{red-fg}\u2717{/red-fg} ${item}`;
            },
            details: async (item) => {
                if (!orderedFiles.includes(item)) {
                    return [
                        '{bold}Conflict resolver{/bold}',
                        '',
                        'No conflicted files detected. Pick an action:',
                        '',
                        '{green-fg}c{/green-fg} continue  run {bold}git cherry-pick --continue{/bold} (commit the staged result)',
                        '{yellow-fg}s{/yellow-fg} skip      drop the current commit and keep going (sequencer only)',
                        '{red-fg}a{/red-fg} abort     run {bold}git cherry-pick --abort{/bold} and restore HEAD',
                    ].join('\n');
                }
                const isResolved = !unresolved.includes(item);
                const header = isResolved
                    ? `{green-fg}✓ resolved:{/green-fg} {bold}${item}{/bold}`
                    : `{red-fg}✗ unresolved:{/red-fg} {bold}${item}{/bold}`;
                if (isResolved) {
                    return [
                        header,
                        '',
                        'Already staged. Press {green-fg}c{/green-fg} once every file is resolved to continue,',
                        'or open it again with {cyan-fg}enter{/cyan-fg} if you want to edit further.',
                    ].join('\n');
                }
                let stat = '';
                try {
                    const { stdout } = await bash.execCommand(`git diff --stat -- ${JSON.stringify(item)}`);
                    stat = stdout.trim();
                } catch { /* noop */ }

                return [
                    header,
                    '',
                    '{bold}enter{/bold}  open in {cyan-fg}nvim {item} -c Gvdiffsplit!{/cyan-fg}',
                    '       (HEAD on the left, working copy with markers on the right)',
                    '       Save and quit with {bold}:wqa{/bold}; if no {red-fg}<<<<<<<{/red-fg}/{red-fg}======={/red-fg}/{red-fg}>>>>>>>{/red-fg}',
                    '       markers remain, the file is auto-staged ({bold}git add{/bold}).',
                    '',
                    '{gray-fg}Manual workflow if you prefer:{/gray-fg}',
                    '  - edit the file and remove all conflict markers',
                    '  - {bold}git add <file>{/bold}',
                    '  - come back and press {green-fg}c{/green-fg} once everything is staged',
                    '',
                    '{gray-fg}Stat (working tree vs index):{/gray-fg}',
                    stat || '  <no diff yet>',
                ].join('\n').replace('{item}', item);
            },
            detailsUseTags: true,
            secondaryDetails: () => [
                '{bold}What is happening{/bold}',
                '',
                'A cherry-pick is in progress. Git stopped because applying the commit',
                'caused conflicts in one or more files. Each unresolved file currently',
                'contains markers like:',
                '  {red-fg}<<<<<<< HEAD{/red-fg}',
                '  your version',
                '  {red-fg}======={/red-fg}',
                '  the cherry-picked version',
                '  {red-fg}>>>>>>> <commit>{/red-fg}',
                '',
                '{bold}Resolve each one{/bold}, stage it ({bold}git add{/bold}), then press {green-fg}c{/green-fg} to continue.',
                'If you change your mind, {red-fg}a{/red-fg} aborts cleanly and restores HEAD.',
            ].join('\n'),
            secondaryDetailsUseTags: true,
            secondaryLabel: 'workflow',
            showDetailsPanel: true,
            actions: [
                { id: 'continue', keys: ['c', 'C'], label: 'c continue' },
                { id: 'skip', keys: ['s', 'S'], label: 's skip' },
                { id: 'abort', keys: ['a', 'A'], label: 'a abort' },
            ],
        });
        if (result.action === 'continue') {
            const stillUnresolved = await getConflictedFiles();
            if (stillUnresolved.length > 0) {
                continue;
            }
            const cont = await withTempScreen('cherry-pick · continue', async (screen) => {
                return new Promise<{ ok: boolean }>((resolve) => {
                    const restore = pauseScreen(screen);
                    const p = spawn('git', ['cherry-pick', '--continue'], { stdio: 'inherit' });
                    p.on('close', (code: number | null) => { restore(); resolve({ ok: code === 0 }); });
                    p.on('error', () => { restore(); resolve({ ok: false }); });
                });
            });
            if (cont.ok) return { outcome: 'applied', message: `cherry-pick onto ${branch} completed` };

            return { outcome: 'failed', message: 'git cherry-pick --continue failed' };
        }
        if (result.action === 'abort') {
            try {
                await bash.execCommand('git cherry-pick --abort');

                return { outcome: 'aborted', message: 'cherry-pick aborted' };
            } catch (e) {
                return { outcome: 'failed', message: `failed to abort: ${(e as Error).message}` };
            }
        }
        if (result.action === 'skip') {
            try {
                await bash.execCommand('git cherry-pick --skip');

                return { outcome: 'skipped', message: 'cherry-pick skipped' };
            } catch (e) {
                return { outcome: 'failed', message: `failed to skip: ${(e as Error).message}` };
            }
        }
        if (result.value === null) {
            continue;
        }
        const file = result.value;
        if (!orderedFiles.includes(file)) {
            continue;
        }
        await withTempScreen(`cherry-pick · edit ${file}`, async (screen) => {
            await runInherit('nvim', [file, '-c', 'Gvdiffsplit!'], screen);
        });
        const remaining = await bash.grepFileForString(file, '<<<<<<<|=======|>>>>>>>');
        if (!remaining) {
            try { await bash.execCommand(`git add ${JSON.stringify(file)}`); } catch { /* noop */ }
        }
    }
}

export async function interactiveCherryPick(hash: string, shortHash: string, branch: string): Promise<CherryPickResult> {
    if (await isCherryPickInProgress()) {
        return resolveConflicts(branch);
    }
    for (;;) {
        const summary = await commitSummary(hash);
        const result = await pickList({
            title: `cherry-pick ${shortHash} onto ${branch}`,
            header: `Cherry-pick {cyan-fg}${shortHash}{/cyan-fg} onto {magenta-fg}${branch}{/magenta-fg}`,
            items: MENU_OPTIONS.map((o) => o.id),
            itemsUseTags: true,
            renderItem: (id) => {
                const opt = MENU_OPTIONS.find((o) => o.id === id);
                if (!opt) return id;
                if (opt.id === 'cancel') return `{red-fg}${opt.label}{/red-fg}`;
                if (opt.id.startsWith('preview')) return `{yellow-fg}${opt.label}{/yellow-fg}`;

                return `{green-fg}${opt.label}{/green-fg}`;
            },
            details: (id) => {
                const o = MENU_OPTIONS.find((x) => x.id === id);

                return o ? o.explain : '';
            },
            detailsUseTags: true,
            secondaryDetails: () => summary,
            secondaryLabel: 'commit',
            showDetailsPanel: true,
        });
        if (result.value === null) return { outcome: 'cancelled', message: 'cherry-pick cancelled' };
        const opt = MENU_OPTIONS.find((o) => o.id === result.value);
        if (!opt || opt.id === 'cancel') return { outcome: 'cancelled', message: 'cherry-pick cancelled' };
        if (opt.id === 'preview-commit') {
            await withTempScreen(`cherry-pick · preview ${shortHash}`, async (screen) => {
                await runInherit('sh', ['-c', `git show --color=always ${hash} | less -R`], screen);
            });
            continue;
        }
        if (opt.id === 'preview-files') {
            const files = await changedFiles(hash);
            await pickList({
                title: `cherry-pick · files in ${shortHash}`,
                header: `${files.length} file(s) changed in ${shortHash}`,
                items: files.length > 0 ? files : ['<no files>'],
                showDetailsPanel: false,
            });
            continue;
        }
        const cp = await runCherryPick(opt.args, hash);
        if (cp.ok) {
            if (opt.id === 'no-commit') {
                return { outcome: 'applied', message: `staged changes from ${shortHash} (no commit created)` };
            }

            return { outcome: 'applied', message: `cherry-picked ${shortHash} onto ${branch}` };
        }
        if (await isCherryPickInProgress()) {
            const conflictResult = await resolveConflicts(branch);
            if (conflictResult.outcome === 'cancelled') continue;

            return conflictResult;
        }

        return { outcome: 'failed', message: cp.stderr.trim() || `cherry-pick failed for ${shortHash}` };
    }
}
