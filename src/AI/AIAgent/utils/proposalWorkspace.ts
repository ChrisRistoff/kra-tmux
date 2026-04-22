import * as bash from '@/utils/bashHelper';

export interface ProposalWorkspace {
    repoRoot: string;
    workspacePath: string;
}

function quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function run(command: string): Promise<string> {
    const result = await bash.execCommand(command);

    return result.stdout.trim();
}

async function getRelativePaths(command: string): Promise<string[]> {
    const output = await run(command);

    if (!output) {
        return [];
    }

    return output.split('\n').filter(Boolean);
}

export async function createProposalWorkspace(): Promise<ProposalWorkspace> {
    const repoRoot = await run('git rev-parse --show-toplevel');

    return { repoRoot, workspacePath: repoRoot };
}

export async function listProposalChanges(workspacePath: string): Promise<string[]> {
    const modified = await getRelativePaths(
        `git -C ${quote(workspacePath)} diff --name-only HEAD`
    );
    const untracked = await getRelativePaths(
        `git -C ${quote(workspacePath)} ls-files --others --exclude-standard`
    );

    return [...new Set([...modified, ...untracked])];
}

export async function readProposalDiff(workspacePath: string): Promise<string> {
    // Save index state so staging doesn't lose manually-staged changes
    const savedTree = (await bash.execCommand(
        `git -C ${quote(workspacePath)} write-tree`
    )).stdout.trim();

    try {
        await bash.execCommand(`git -C ${quote(workspacePath)} add -A`);

        const result = await bash.execCommand(
            `git --no-pager -C ${quote(workspacePath)} diff --cached HEAD`
        );

        return result.stdout;
    } finally {
        await bash.execCommand(
            `git -C ${quote(workspacePath)} read-tree ${quote(savedTree)}`
        );
    }
}

export async function hasProposalChanges(workspacePath: string): Promise<boolean> {
    const changedFiles = await listProposalChanges(workspacePath);

    return changedFiles.length > 0;
}

export async function applyProposalToRepo(_repoRoot: string, _workspacePath: string): Promise<string> {
    return 'Changes are already written to the repository.';
}

export async function rejectProposal(workspacePath: string): Promise<void> {
    await bash.execCommand(`git -C ${quote(workspacePath)} restore .`);
    await bash.execCommand(`git -C ${quote(workspacePath)} clean -fd`);
}

export async function removeProposalWorkspace(_repoRoot: string, _workspacePath: string): Promise<void> {
    // No-op: agent writes directly to the repository, nothing to remove.
}
