import * as gitFiles from '@git/utils/gitFileUtils';
import * as ui from '@UI/generalUI';
import * as nvim from '@utils/neovimHelper';

export async function handleViewChanged(): Promise<void> {
    const changedFiles = new Set([...await gitFiles.getModifiedFiles(), ...await gitFiles.getUntrackedFiles()]);

    while (changedFiles.size > 0) {
        const file = await ui.searchSelectAndReturnFromArray({
            itemsArray: Array.from(changedFiles),
            prompt: "Pick a file to view: "
        })

        if (process.env.TMUX) {
            await nvim.openNvimInTmuxAndWait(file);
        } else {
            await nvim.openVim(file);
        }

        changedFiles.delete(file);
    }
}
