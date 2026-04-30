import * as gitFiles from '@/git/utils/gitFileUtils';
import { browseFiles, runInherit, withTempScreen } from '@/UI/dashboard/screen';

export async function handleViewChanged(): Promise<void> {
    const files = [
        ...await gitFiles.getModifiedFiles(),
        ...await gitFiles.getUntrackedFiles(),
    ];
    if (files.length === 0) {
        console.log('No changed files.');

        return;
    }

    await withTempScreen('git changed files', async (screen) => {
        await browseFiles(screen, {
            title: 'changed files',
            files,
            view: async (file) => {
                await runInherit('nvim', [file, '-c', 'Gvdiffsplit'], screen);
            },
        });
    });
}

