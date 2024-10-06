import { spawn, exec } from 'child_process';
import { AllowedCommandsToFail } from '../types/bashTypes';

const allowedCommandsForNoCode: AllowedCommandsToFail = {
    // NOTE: Example usage
    // 'tmux': new Set(['attach-session'])
}

export async function runCommand(command: string, args? : string[], options = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, options);

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else if (isCommandValidWithNoCode(command, args)) {
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

function isCommandValidWithNoCode(command: string, args: string[] | undefined): boolean {
    if (!allowedCommandsForNoCode[command]) {
        return false;
    }

    if (!args) {
        return false;
    }

    for (let i = 0; i < allowedCommandsForNoCode[command].size ; i++) {
        if (!allowedCommandsForNoCode[command].has(args[i])) {
            return false;
        }
    }

    return true;
}
