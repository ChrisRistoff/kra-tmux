import * as bash from '../helpers/bashHelper'

export async function saveNvimSession(session: string, windowIndex: number, paneIndex: number): Promise<void> {
    const command = `tmux send-keys -t ${session}:${windowIndex}.${paneIndex} ":mksession ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim" C-m`;
    await bash.execCommand(command);

    console.log(`Neovim session saved in: ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim`);
}

export async function loadNvimSession(session: string, windowIndex: number, paneIndex: number) {
    const command = `tmux send-keys -t ${session}:${windowIndex}.${paneIndex} "nvim -S ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim" C-m`;
    await bash.execCommand(command);

    console.log(`Neovim sesiion loaded from: ${__dirname}/../../../tmux-files/nvim-sessions/${session}_${windowIndex}_${paneIndex}.vim`);
}
