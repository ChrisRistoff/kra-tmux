import 'module-alias/register';
import { workerData, parentPort } from 'worker_threads';
import * as bash from '../../utils/bashHelper';
import { nvimSessionsPath } from '@/filePaths';
import { Window } from '@/types/sessionTypes';

interface WindowWorkerData {
    sessionName: string;
    windowIndex: number;
    window: Window;
    serverName: string
}

const generateWindowCommands = (data: WindowWorkerData): string[] => {
    const { sessionName, windowIndex, window, serverName } = data;
    const commands: string[] = [];

    if (windowIndex > 0) {
        commands.push(`tmux new-window -t ${sessionName} -n ${window.windowName} -c ~/`);
    }

    // pane creation
    window.panes.forEach((_: any, paneIndex: number) => {
        if (paneIndex > 0) {
            commands.push(`tmux split-window -t ${sessionName}:${windowIndex} -c ~/`);
        }
    });

    // pane setup
    commands.push(
        `tmux select-layout -t ${sessionName}:${windowIndex} "${window.layout}" || tmux select-layout -t ${windowIndex} tiled`,
        `tmux select-pane -t ${sessionName}:${windowIndex}.0`
    );

    // Pane commands
    window.panes.forEach((pane: any, paneIndex: number) => {
        const pathCmd = pane.currentPath.split('/').slice(3).join('/');
        commands.push(
            `tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} "cd ${pathCmd}" Enter`
        );

        if (pane.currentCommand === "nvim") {
            const nvimFile = `${nvimSessionsPath}/${serverName}/${sessionName}_${windowIndex}_${paneIndex}.vim`;
            commands.push(
                `tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} ` +
                `'test -f "${nvimFile}" && nvim -S "${nvimFile}" || nvim' Enter`
            );
        }
    });

    return commands;
};

const processWindow = async () => {
    try {
        const commands = generateWindowCommands(workerData);
        await bash.execCommand(commands.join(' && '));
        parentPort?.postMessage({ success: true });
    } catch (error) {
        parentPort?.postMessage({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

processWindow();
