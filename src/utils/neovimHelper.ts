import * as fs from 'fs';
import * as bash from '@utils/bashHelper';
import { spawn } from 'child_process';
import { nvimSessionsPath, nvimTreeSwapFilePath } from '@filePaths';

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

export async function loadNvimSession(folderName: string, session: string, windowIndex: number, paneIndex: number) {
    await bash.sendKeysToTmuxTargetSession({
        sessionName: session,
        windowIndex,
        paneIndex,
        command: `nvim -S ${nvimSessionsPath}/${folderName}/${session}_${windowIndex}_${paneIndex}.vim`,
    });
}

export function openVim(filePath: string, command?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const vimProcess = spawn('nvim', [filePath], {
            stdio: 'inherit',
            shell: true,
        });

        if (command) {
            bash.sendKeysToTmuxTargetSession({
                command
            });
        }

        vimProcess.on('close', (code) => {
            if (code === 0) {
                console.log('Vim exited successfully');
                resolve();
            } else {
                console.log(`Vim exited with code ${code}`);
                reject(new Error(`Vim exited with code ${code}`));
            }
        });

        vimProcess.on('error', (err) => {
            console.error('Failed to start Vim:', err);
            reject(err);
        });
    });
}

export async function openNvimInTmuxAndWait(filePath: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        try {
            await bash.execCommand(`tmux new-window "nvim +'normal GA' '${filePath}'; tmux wait-for -S vim-done"`);

            // wait for the marker to be set
            await bash.execCommand('tmux wait-for vim-done');

            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

export function cleanNvimTree(): void {
    bash.execCommand(`rm ${nvimTreeSwapFilePath}`);
}
