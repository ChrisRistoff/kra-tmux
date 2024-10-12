import * as bash from '../helpers/bashHelper'
import { spawn } from 'child_process';

export async function saveNvimSession(session: string, windowIndex: number, paneIndex: number): Promise<void> {
    const command = `tmux send-keys -t ${session}:${windowIndex}.${paneIndex} ":mksession ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim" C-m`;
    await bash.execCommand(command);
}

export async function loadNvimSession(session: string, windowIndex: number, paneIndex: number) {
    const command = `tmux send-keys -t ${session}:${windowIndex}.${paneIndex} "nvim -S ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim" C-m`;
    await bash.execCommand(command);
}

export async function openVim(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const vimProcess = spawn('vim', [filePath], {
            stdio: 'inherit',
            shell: true,
        });

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
