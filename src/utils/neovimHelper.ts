import * as fs from 'fs';
import * as bash from '@utils/bashHelper';
import { spawn } from 'child_process';
import { nvimSessionsPath } from '@filePaths';

export async function saveNvimSession(folderName: string, session: string, windowIndex: number, paneIndex: number): Promise<void> {
    const nvimSessionFileName = `${session}_${windowIndex}_${paneIndex}.vim`;

    if (!fs.existsSync(nvimSessionsPath)) {
        fs.mkdirSync(nvimSessionsPath, { recursive: true} );
    }

    if (!fs.existsSync(`${nvimSessionsPath}/${folderName}`)) {
        fs.mkdirSync(`${nvimSessionsPath}/${folderName}`, { recursive: true} );
    }

    if (fs.existsSync(`${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`)) {
        fs.unlinkSync(`${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`);
    }

    await bash.sendKeysToTmuxTargetSession({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `:mksession ${nvimSessionsPath}/${folderName}/${nvimSessionFileName}`,
    });
}

export async function loadNvimSession(folderName: string, session: string, windowIndex: number, paneIndex: number): Promise<void> {
    await bash.sendKeysToTmuxTargetSession({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `nvim -S ${nvimSessionsPath}/${folderName}/${session}_${windowIndex}_${paneIndex}.vim`,
    });
}

export async function openVim(filePath: string, ...args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const vimProcess = spawn('nvim', [filePath, ...args], {
            stdio: 'inherit',
            shell: false,
        });

        vimProcess.on('close', (code: number) => {
            if (code === 0) {
                return resolve();
            } else {
                console.log(`Vim exited with code ${code}`);

                return reject(new Error(`Vim exited with code ${code}`));
            }
        });

        vimProcess.on('error', (err) => {
            console.error('Failed to start Vim:', err);

            return reject(err);
        });
    });
}

export async function openNvimInTmuxAndWait(filePath: string): Promise<void> {
    try {
        await bash.execCommand(`tmux new-window "nvim +'normal GA' '${filePath}'; tmux wait-for -S vim-done"`);

        // wait for the marker to be set
        await bash.execCommand('tmux wait-for vim-done');
    } catch (error) {
        throw error;
    }
}
