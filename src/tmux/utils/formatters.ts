import * as bash from '@/utils/bashHelper';
import { Window, Pane } from '@/types/sessionTypes';

export async function formatPane(pane: string): Promise<Pane> {
    const [panePid, currentPath, paneCoords] = pane.split(':');
    const [paneLeft, paneTop] = paneCoords.split('x');
    const gitRepoLink = await getGitRepoLink(currentPath);

    return {
        currentCommand: await getForegroundCommand(panePid),
        currentPath,
        gitRepoLink,
        paneLeft,
        paneTop,
    };
}

export async function formatWindow(window: string): Promise<Window> {
    const [windowName, currentCommand, currentPath, layout] = window.split(':');
    const gitRepoLink = await getGitRepoLink(currentPath);

    return {
        windowName,
        layout,
        gitRepoLink,
        currentCommand,
        currentPath,
        panes: []
    };
}

async function getGitRepoLink(path: string): Promise<string | undefined> {
    try {
        const { stdout } = await bash.execCommand(`git -C ${path} remote get-url origin`);

        return stdout.split('\n')[0];
    } catch (_error) {
        return undefined;
    }
}

async function getForegroundCommand(panePid: string): Promise<string> {
    try {
        // get children of the pane process
        const { stdout } = await bash.execCommand(`pgrep -P ${panePid}`);
        const childPids = stdout.toString().trim().split("\n").filter(Boolean);

        if (childPids.length === 0) {
            return "";
        }

        // assume the last child is the foreground process
        const lastPid = childPids[childPids.length - 1];
        const { stdout: cmd } = await bash.execCommand(`ps -p ${lastPid} -o comm=`);
        return cmd.toString().trim();
    } catch (e) {
        return "";
    }
}
