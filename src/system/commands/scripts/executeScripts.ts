import fs from 'fs/promises';
import { systemScriptsPath } from '@/filePaths';
import * as ui from '@/UI/generalUI';
import * as bash from '@/utils/bashHelper';
import * as utils from '@/system/utils/fileUtils'
import { filterGitKeep } from '@/utils/common';

export async function executeScript(): Promise<void> {
    const availableScripts = filterGitKeep(await fs.readdir(systemScriptsPath));

    const scriptToRun = await ui.searchSelectAndReturnFromArray({
        itemsArray: availableScripts,
        prompt: 'Choose a script to run',
        header: `${availableScripts.length} script(s) available`,
        details: async (name) => {
            try {
                const buf = await fs.readFile(`${systemScriptsPath}/${name}`, 'utf-8');
                const lines = buf.split('\n');
                const head = lines.slice(0, 80).join('\n');

                return `script: ${name}\nlines: ${lines.length}\n\n--- first 80 lines ---\n${head}`;
            } catch (e: unknown) {
                return `Failed to read script: ${e instanceof Error ? e.message : String(e)}`;
            }
        },
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
