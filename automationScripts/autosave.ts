import * as bash from '../src/utils/bashHelper';
import { createIPCServer } from '../eventSystem/ipc';
import { createLockFile, deleteLockFile, lockFileExist, LockFiles } from '../eventSystem/lockFiles';

const scheduledJobs = new Set<string>();
let saveTimer: NodeJS.Timeout | undefined;

async function resetSaveTimer() {
    if (!process.env.TMUX || await lockFileExist(LockFiles.LoadInProgress)) {
        await deleteLockFile(LockFiles.AutoSaveInProgress);
        process.exit(0);
    }

    if (saveTimer) {
        clearTimeout(saveTimer)
    }

    saveTimer = setTimeout(async () => {
        if (scheduledJobs.size > 0) {
            try {
                await bash.execCommand('kra tmux quicksave');
                console.log(`Saved: ${Array.from(scheduledJobs).join(', ')}`);
                await deleteLockFile(LockFiles.AutoSaveInProgress);
                server.close();
                process.exit(0);
            } catch (error) {
                await deleteLockFile(LockFiles.AutoSaveInProgress);
                console.error('Save failed:', error);
            }
        }
    }, 20000);
}

const server = createIPCServer('/tmp/autosave.sock');

server.addListener(event => {
    console.log(`Event received: ${event}`);
    scheduledJobs.add(event);
    resetSaveTimer();
});

createLockFile(LockFiles.AutoSaveInProgress);
resetSaveTimer();
