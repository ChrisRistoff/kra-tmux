import { exec } from 'child_process';
import { SendKeysArguments } from '@/types/bashTypes';

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

export async function sendKeysToTargetSessionAndWait(options: SendKeysArguments): Promise<void> {
    const marker = `__DONE_`;
    const cmdWithMarker = `echo ${marker}`;

    await sendKeysToTmuxTargetSession({ ...options, command: cmdWithMarker });

    await waitForTmuxMarker(options, marker);
}

async function waitForTmuxMarker(options: SendKeysArguments, marker: string) {
    return new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
            const target = getTmuxTarget(options);
            const { stdout } = await execCommand(`tmux capture-pane -p -t ${target}`);

            if (stdout.includes(marker)) {
                clearInterval(interval);
                resolve();
            }
        }, 200);
    });
}

function getTmuxTarget({ sessionName, windowIndex, paneIndex }: SendKeysArguments): string {
    let target = '';

    if (sessionName) {
        target += sessionName;
    }

    if (typeof windowIndex === 'number') {
        target += `:${windowIndex}`;
    }

    if (typeof paneIndex === 'number') {
        target += `.${paneIndex}`;
    }

    return target;
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
        return false;
    }
}
