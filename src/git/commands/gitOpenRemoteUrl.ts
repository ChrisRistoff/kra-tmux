import { getCurrentBranch } from '@git/core/gitBranch';
import * as bash from '@utils/bashHelper';
import { platform } from 'os';
import { URL } from 'url';

export async function openRemoteUrl(): Promise<void> {
    const branchName = await getCurrentBranch();
    const { stdout: rawRepoUrl } = await bash.execCommand('git remote get-url origin');
    const repoUrl = rawRepoUrl.trim();

    let prUrl: string;
    let parsedUrl: URL;

    try {
        parsedUrl = new URL(repoUrl);
    } catch {
        // handle ssh
        const [hostPath, repoPath] = repoUrl.split(':');
        const [_, host, ...userParts] = hostPath.split('@');
        const user = userParts.join('@');
        const [repoOwner, repoName] = repoPath.split('/').map(p => p.replace('.git', ''));

        parsedUrl = new URL(`https://${host}/${user}/${repoOwner}/${repoName}`);
    }

    if (parsedUrl.hostname === 'github.com') {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

        prUrl = `https://github.com/${pathParts[0]}/${pathParts[1]}/pull/new/${branchName}`;
    } else if (parsedUrl.hostname === 'bitbucket.org') {
        const [workspace, repo] = parsedUrl.pathname.split('/').filter(Boolean);

        prUrl = `https://bitbucket.org/${workspace}/${repo}/pull-requests/new?source=${branchName}`;
    } else {
        throw new Error('Unsupported Git host.');
    }

    const command = platform() === 'darwin' ? 'open' : 'xdg-open';
    await bash.execCommand(`${command} ${prUrl}`);
}
