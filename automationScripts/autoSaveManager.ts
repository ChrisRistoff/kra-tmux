import { createIPCClient } from '../eventSystem/ipc';
import * as bash from '../src/utils/bashHelper';
import os from 'os';
import { lockFileExist, LockFiles } from '../eventSystem/lockFiles';

async function main() {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        process.exit(0);
    }

    const event = process.argv[2];
    console.log(event);
    const client = createIPCClient('/tmp/autosave.sock');

    if (!await lockFileExist(LockFiles.AutoSaveInProgress)) {
        const cmd = `${'~/programming/kra-tmux/dest/automationScripts/autosave.js'.replace('~', os.homedir())}`;

        bash.runCommand('node', [cmd], {
            detached: true,
            stdio: 'ignore'
        });
    }

    await client.ensureConnected();
    await client.emit(event);

    process.exit(0);
}

main();
