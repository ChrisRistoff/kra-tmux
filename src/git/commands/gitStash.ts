import * as bash from "../../helpers/bashHelper";
import * as ui from '../../UI/generalUI';
import { getStashes } from "../utils/gitFileUtils";

export async function applyOrDropStash(): Promise<void> {
    const stashList = await getStashes();

    const stash = await ui.searchSelectAndReturnFromArray({
        itemsArray: stashList,
        prompt: 'Pick a stash from the list to apply or drop',
    });

    const applyOrDrop = await ui.searchSelectAndReturnFromArray({
        itemsArray: ['apply', 'drop'],
        prompt: 'Choose what you want to do with the stash'
    });

    const command = `git stash ${applyOrDrop} stash@\{${stashList.indexOf(stash)}\}`;
    await bash.execCommand(command);
    console.log(`Stash ${applyOrDrop}ed: ${stash}`);
}

export async function dropMultipleStashes(): Promise<void> {
    while (true) {
        const stashList = await getStashes();
        const stash = await ui.searchSelectAndReturnFromArray({
            itemsArray: ['stop', ...stashList],
            prompt: 'Pick a stash from the list to drop',
        });

        if (stash === 'stop') {
            return;
        }

        const command = `git stash drop stash@\{${stashList.indexOf(stash)}\}`;
        await bash.execCommand(command);
        console.log(`Stash dropped: ${stash}`);
    }
}
