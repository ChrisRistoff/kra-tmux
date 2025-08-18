import 'module-alias/register';
import { createIPCClient } from '../eventSystem/ipc';
import os from 'os';
import { lockFileExist, LockFiles, oneOfMultipleLocksExist } from '../eventSystem/lockFiles';
import { loadSettings } from '@/utils/common';

async function main() {
    if (
        !process.env.TMUX
        || await oneOfMultipleLocksExist([LockFiles.LoadInProgress, LockFiles.ServerKillInProgress])
        || await loadSettings().then(res => !res.autosave.active)
    ) {
        process.exit(0);
    }

    const event = process.argv[2];

    const client = createIPCClient('/tmp/autosave.sock');

    if (!await lockFileExist(LockFiles.AutoSaveInProgress)) {
        const script = `${'~/programming/kra-tmux/dest/automationScripts/autosave.js'.replace('~', os.homedir())}`;

        await client.ensureServerRunning(script);
    }

    await client.emit(event);

    process.exit(0);
}

main().then(_res => {});
