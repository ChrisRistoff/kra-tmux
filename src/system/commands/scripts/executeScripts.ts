import { systemScriptsPath } from '@/filePaths';
import * as ui from '@UI/generalUI';
import * as bash from '@utils/bashHelper';
import * as utils from '@system/utils/fileUtils'
import fs from 'fs/promises';
import { filterGitKeep } from '@/utils/common';

export async function executeScript(): Promise<void> {
    const availableScripts = filterGitKeep(await fs.readdir(systemScriptsPath));

    const scriptToRun = await ui.searchSelectAndReturnFromArray({
        itemsArray: availableScripts,
        prompt: 'Choose a script from the list to run: '
    })

    const scriptFilePath = `${systemScriptsPath}/${scriptToRun}`;

    await utils.makeExecutableIfNoPermissions(scriptFilePath);

    const script = await bash.execCommand(`sh ${scriptFilePath}`);

    if (script.stdout) {
        console.log(script.stdout);
    } else if (script.stderr) {
        console.log(script.stderr);
    }
}
