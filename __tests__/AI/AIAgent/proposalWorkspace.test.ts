import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
    applyProposalToRepo,
    createProposalWorkspace,
    hasProposalChanges,
    listProposalChanges,
    readProposalDiff,
    rejectProposal,
    removeProposalWorkspace,
} from '@/AI/AIAgent/shared/utils/proposalWorkspace';

function git(cwd: string, command: string): string {
    return execSync(`git ${command}`, { cwd, encoding: 'utf8' }).trim();
}

describe('proposalWorkspace', () => {
    let originalCwd: string;
    let repoRoot: string;
    let workspacePath: string | undefined;

    beforeEach(async () => {
        originalCwd = process.cwd();
        repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kra-agent-repo-'));

        git(repoRoot, 'init');
        git(repoRoot, `config user.name "Test User"`);
        git(repoRoot, `config user.email "test@example.com"`);
        git(repoRoot, 'config commit.gpgsign false');
        await fs.writeFile(path.join(repoRoot, 'note.txt'), 'hello\n', 'utf8');
        git(repoRoot, 'add note.txt');
        git(repoRoot, 'commit -m "initial"');
        process.chdir(repoRoot);
    });

    afterEach(async () => {
        process.chdir(originalCwd);

        if (workspacePath) {
            await removeProposalWorkspace(repoRoot, workspacePath);
            workspacePath = undefined;
        }

        await fs.rm(repoRoot, { recursive: true, force: true });
    });

    it('surfaces and applies modified and newly created files', async () => {
        const workspace = await createProposalWorkspace();
        workspacePath = workspace.workspacePath;

        await fs.writeFile(path.join(workspacePath, 'note.txt'), 'hello from proposal\n', 'utf8');
        await fs.writeFile(path.join(workspacePath, 'new-file.txt'), 'brand new file\n', 'utf8');

        await expect(hasProposalChanges(workspacePath)).resolves.toBe(true);
        await expect(listProposalChanges(workspacePath)).resolves.toEqual(
            expect.arrayContaining(['note.txt', 'new-file.txt'])
        );

        const diff = await readProposalDiff(workspacePath);
        expect(diff).toContain('hello from proposal');
        expect(diff).toContain('new file mode 100644');

        await expect(applyProposalToRepo(repoRoot, workspacePath)).resolves.toBe(
            'Changes are already written to the repository.'
        );

        await expect(fs.readFile(path.join(repoRoot, 'note.txt'), 'utf8')).resolves.toBe('hello from proposal\n');
        await expect(fs.readFile(path.join(repoRoot, 'new-file.txt'), 'utf8')).resolves.toBe('brand new file\n');
    });

    it('rejects proposal changes by resetting the workspace', async () => {
        const workspace = await createProposalWorkspace();
        workspacePath = workspace.workspacePath;

        await fs.writeFile(path.join(workspacePath, 'note.txt'), 'discard me\n', 'utf8');

        await rejectProposal(workspacePath);

        await expect(hasProposalChanges(workspacePath)).resolves.toBe(false);
        await expect(fs.readFile(path.join(workspacePath, 'note.txt'), 'utf8')).resolves.toBe('hello\n');
    });
});
