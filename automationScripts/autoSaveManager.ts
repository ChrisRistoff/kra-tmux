import { createIPCClient } from '../eventSystem/ipc';
import os from 'os';
import { lockFileExist, LockFiles } from '../eventSystem/lockFiles';

async function main() {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        process.exit(0);
    }

    const event = process.argv[2];

    const client = createIPCClient('/tmp/autosave.sock');

    if (!await lockFileExist(LockFiles.AutoSaveInProgress)) {
        const script = `${'~/programming/kra-tmux/dest/automationScripts/autosave.js'.replace('~', os.homedir())}`;

        await client.ensureServerRunning(script);
    }

    await client.ensureConnected();
    await client.emit(event);

    process.exit(0);
}

main().then(() => console.log('Controller out'));
