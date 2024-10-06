import { spawn, exec } from 'child_process';

export async function runCommand(command: string, args? : string[], options = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, options);

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command "${command} ${args?.join(' ')}" failed with code ${code}`));
            }
        });

        process.on('error', reject);
    });
};

export async function execCommand(command: string): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
};
