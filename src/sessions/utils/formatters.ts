import * as bash from '@utils/bashHelper';
import { Window, Pane } from '@customTypes/sessionTypes';

export async function formatPane(pane: string): Promise<Pane> {
    const [currentCommand, currentPath, paneCoords] = pane.split(':');
    const [paneLeft, paneTop] = paneCoords.split('x');
    const gitRepoLink = await getGitRepoLink(currentPath);

    return {
        currentCommand,
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
