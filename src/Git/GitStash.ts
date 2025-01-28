import { BaseGit } from "./BaseGit";
import * as bash from "../helpers/bashHelper";
import * as ui from '../UI/generalUI';

export class GitStash extends BaseGit {

    public async applyOrDropStash(): Promise<void> {
        const stashList = await this.getArrayOfStashes();

        const stash = await ui.searchSelectAndReturnFromArray({
            itemsArray: stashList,
            prompt: 'Pick a stash from the list to apply or drop',
        });

        const applyOrDrop = await ui.searchSelectAndReturnFromArray({
            itemsArray: ['apply', 'drop'],
            prompt: 'Choose what you want to do with the stash'
        })

        const command = `git stash ${applyOrDrop} stash@\{${stashList.indexOf(stash)}\}`;

        await bash.execCommand(command);

        console.log(`Stash dropped: ${stash}`)
    }

    public async dropMultipleStashes(): Promise<void> {
        let stash: string = '';

        while (true) {
            const stashList = await this.getArrayOfStashes();

            stash = await ui.searchSelectAndReturnFromArray({
                itemsArray: ['stop', ...stashList],
                prompt: 'Pick a stash from the list to apply',
            });

            if (stash === 'stop') {
                return;
            }

            const command = `git stash drop stash@\{${stashList.indexOf(stash)}\}`;

            await bash.execCommand(command);

            console.log(`Stash dropped: ${stash}`)
        }
    }

    private async getArrayOfStashes(): Promise<string[]> {
        const stash = await bash.execCommand('git stash list --format="%s"');

        const stashArray = stash.stdout.split('\n');
        stashArray.pop();

        return stashArray;
    }
}
