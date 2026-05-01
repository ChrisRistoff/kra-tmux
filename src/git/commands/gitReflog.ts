import { gitLogDashboard } from '@/git/commands/gitLogDashboard';

export async function browseReflog(): Promise<void> {
    await gitLogDashboard({
        title: 'git reflog',
        listLabel: 'reflog',
        logArgs: ['reflog', '--date=relative'],
        graphArgs: ['log', '--reflog'],
        fmtFields: ['%H', '%h', '%an', '%ae', '%cr', '%aI', '%gD %gs', '%s', '%b'],
    });
}