import * as bash from './helpers/bashHelper';

export async function removeLastWindowTempHack(sessionName: string) {
    const windows = await bash.execCommand(`tmux list-windows -t ${sessionName}`)

    const windowsArray = windows.stdout.split('\n');
    windowsArray.pop();

    let max = 0;
    windowsArray.forEach((window: string) => {
        const windowNumber = Number(window.split(':')[0])

        if (typeof windowNumber === 'number') {
            max = Math.max(max, windowNumber);
        }
    })

    const killLastWindow = `tmux kill-window -t ${sessionName}:${max}`
    await bash.execCommand(killLastWindow);
}
