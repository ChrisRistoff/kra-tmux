import 'module-alias/register';
import { parentPort, workerData } from 'worker_threads';
import * as bash from '../../utils/bashHelper';
import { SessionWorkerData, WorkerResult } from '@/types/workerTypes';
import { nvimSessionsPath } from '@/filePaths';

const executeWorker = async (): Promise<void> => {
    try {
        const { sessionName, sessionData, fileName }: SessionWorkerData = workerData;

        const neovimSessionFilePath = `${nvimSessionsPath}/${fileName}`;

        const allCommands = generateSessionCommands(sessionName, sessionData, neovimSessionFilePath);

        // execute all commands as one batch
        const batchCommand = allCommands.join(' && ');
        await bash.execCommand(batchCommand);

        const result: WorkerResult = { sessionName, success: true };
        parentPort?.postMessage(result);
    } catch (error) {
        const result: WorkerResult = {
            sessionName: workerData.sessionName,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
        parentPort?.postMessage(result);
    }
};

const generateSessionCommands = (sessionName: string, sessions: any, nvimSessionsPath: string): string[] => {
    const commands: string[] = [];
    const sessionData = sessions[sessionName];

    // create session
    commands.push(`tmux new-session -d -s ${sessionName}`);

    // commands for each window
    sessionData.windows.forEach((window: any, windowIndex: number) => {
        commands.push(...generateWindowCommands(sessionName, windowIndex, window, nvimSessionsPath));
    });

    return commands;
};

const generateWindowCommands = (sessionName: string, windowIndex: number, window: any, nvimSessionsPath: string): string[] => {
    const commands: string[] = [];

    // window 0 will already be created with each new session
    if (windowIndex > 0) {
        commands.push(`tmux new-window -t ${sessionName} -n ${window.windowName} -c ~/`);
    }

    // create panes
    window.panes.forEach((_: any, paneIndex: number) => {
        // pane 0 will already be created with each window
        if (paneIndex > 0) {
            // use target session:window to avoid index issues
            commands.push(`tmux split-window -t ${sessionName}:${windowIndex} -c ~/`);
        }
    });

    // generate pane commands
    window.panes.forEach((pane: any, paneIndex: number) => {
        commands.push(...generatePaneCommands(sessionName, windowIndex, paneIndex, pane, nvimSessionsPath));
    });

    // layout
    try {
        commands.push(`tmux select-layout -t ${sessionName}:${windowIndex} "${window.layout}" || tmux select-layout -t ${sessionName}:${windowIndex} tiled`);
    } catch {
        commands.push(`tmux select-layout -t ${sessionName}:${windowIndex} tiled`);
    }

    commands.push(`tmux select-pane -t ${sessionName}:${windowIndex}.0`);

    return commands;
};

const generatePaneCommands = (sessionName: string, windowIndex: number, paneIndex: number, pane: any, nvimSessionsPath: string): string[] => {
    const commands: string[] = [];

    // navigation commands
    const pathArray = pane.currentPath.split('/');
    const navCommands = ['cd'];

    for (let i = 3; i < pathArray.length; i++) {
        const folderPath = pathArray[i];
        navCommands.push(`[ -d '${folderPath}' ] || (git clone ${pane.gitRepoLink} ${folderPath})`);
        navCommands.push(`cd '${folderPath}'`);
    }

    const navCommand = navCommands.join(' && ');
    commands.push(`tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} "${navCommand}" Enter`);

    // neovim commands
    if (pane.currentCommand === "nvim") {
        const nvimSessionFileName = `${sessionName}_${windowIndex}_${paneIndex}.vim`;
        const nvimSessionFile = `${nvimSessionsPath}/${nvimSessionFileName}`;

        // check file exists first and then send appropriate command
        commands.push(`[ -f "${nvimSessionFile}" ] && echo "Loading session: ${nvimSessionFile}" || echo "No session file found, starting fresh nvim"`);
        commands.push(`tmux send-keys -t ${sessionName}:${windowIndex}.${paneIndex} 'test -f "${nvimSessionFile}" && nvim -S "${nvimSessionFile}" || nvim' Enter`);
    }

    return commands;
};

executeWorker();
