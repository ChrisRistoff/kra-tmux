import { spawn, exec } from 'child_process';
import { AllowedCommandsForNoCode, SendKeysArguments } from '@customTypes/bashTypes';

const allowedCommandsForNoCode: AllowedCommandsForNoCode = {
    'tmux': new Set(['attach-session', 'has-session', 'kill-server']),
    'git': new Set(['get-url'])
};

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
    if (!args) {
        return false;
    }

    for (let i = 0; i < allowedCommandsForNoCode[command].size ; i++) {
        if (allowedCommandsForNoCode[command].has(args[i])) {
            return true;
        }
    }

    return false;
}

export async function sendKeysToTmuxTargetSession(options: SendKeysArguments): Promise<void> {
    let commandString = 'tmux send-keys';
    const windowIndexIsSaved = typeof options.windowIndex === 'number';
    const panelIndexIsSaved = typeof options.paneIndex === 'number';

    if (options.sessionName || windowIndexIsSaved || panelIndexIsSaved) {
        commandString += ' -t ';
    }

    if (options.sessionName) {
        commandString += options.sessionName;
    }

    if (windowIndexIsSaved) {
        commandString += commandString[commandString.length - 1] === ' '
            ? options.windowIndex
            : `:${options.windowIndex}`;
    }

    if (panelIndexIsSaved) {
        commandString += commandString[commandString.length - 1] === ' '
            ? options.paneIndex
            : `.${options.paneIndex}`;
    }

    commandString += ` "${options.command}" C-m`;

    await execCommand(commandString);
}

export async function grepFileForString(fileName: string, searchString: string): Promise<boolean> {
    try {
        const command = `grep -E "${searchString}" '${fileName}'`;

        const { stdout, stderr } = await execCommand(command);

        if (stderr) {
            console.error(`grep error: ${stderr}`);

            return false;
        }

        return stdout !== "";
    } catch (error) {
        console.log(error)

        return false;
    }
}
