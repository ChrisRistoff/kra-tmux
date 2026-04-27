import 'module-alias/register';
import { lockFileExist, LockFiles, oneOfMultipleLocksExist } from '../../eventSystem/lockFiles';
import { loadSettings } from '@/utils/common';
import { createIPCClient, IPCClient, IPCsockets } from '../../eventSystem/ipc';
import { autosaveJsPath } from '@/packagePaths';

async function main() {
    if (
        !process.env.TMUX
        || await oneOfMultipleLocksExist([LockFiles.LoadInProgress, LockFiles.ServerKillInProgress])
        || await loadSettings().then(res => !res.autosave.active)
    ) {
        process.exit(0);
    }

    const event = process.argv[2];

    const client = createIPCClient(IPCsockets.AutosaveSocket);

    await ensureServerRunning(client);

    await client.emit(event);
    process.exit(0);
}

async function ensureServerRunning(client: IPCClient): Promise<void> {
    if (!await lockFileExist(LockFiles.AutoSaveInProgress)) {
        return await client.ensureServerRunning(autosaveJsPath);
    }
}

main().catch(err => {
    console.log('Autosave controller error', err);
    process.exit(1);
})
