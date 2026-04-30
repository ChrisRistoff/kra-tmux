import * as bash from '@/utils/bashHelper';
import { getConflictedFiles } from '@/git/utils/gitFileUtils';
import { browseFiles, runInherit, withTempScreen } from '@/UI/dashboard/screen';
import { Conflicts } from '@/types/gitTypes';

export async function handleConflicts(): Promise<void> {
    const conflictsArray = await getConflictedFiles();
    if (!conflictsArray.length) {
        console.log('No Conflicts to Handle!');

        return;
    }

    await withTempScreen('git conflicts', async (screen) => {
        await browseFiles(screen, {
            title: 'conflicted files',
            files: conflictsArray,
            view: async (file) => {
                await runInherit('nvim', [file, '-c', 'Gvdiffsplit!'], screen);
                const remaining = await bash.grepFileForString(file, '<<<<<<<|=======|>>>>>>>');
                if (remaining) {
                    return false;
                }

                return true;
            },
        });
    });

    const conflictsObject: Conflicts = {};
    conflictsArray.forEach((conflict, index) => {
        conflictsObject[`${index + 1}.File Name`] = conflict;
    });
    console.table(conflictsObject);
}

