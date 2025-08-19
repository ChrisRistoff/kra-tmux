import * as bash from '@/utils/bashHelper';
import { Window, Pane } from '@/types/sessionTypes';

/**
 * Formats raw pane information into a structured Pane object
 * @param pane Raw pane string in "PID:path:leftxTop" format
 * @returns Promise resolving to Pane object with
 * - command
 * - path
 * - git repo
 * - coordinates (left, top)
 */
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

/**
 * Formats raw window information into a structured Window object
 * @param window Raw window string in "name:command:path:layout" format
 * @returns Promise resolving to Window object with
 *   - name
 *   - layout
 *   - git repo
 *   - command
 *   - path
 *   - panes - pane[]
 */
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

/**
 * Retrieves Git remote origin URL for a given path
 * @param path Directory path to check for Git repository
 * @returns Promise resolving to origin URL string or undefined if not found
 */
async function getGitRepoLink(path: string): Promise<string | undefined> {
    try {
        const { stdout } = await bash.execCommand(`git -C ${path} remote get-url origin`);

        return stdout.split('\n')[0];
    } catch (_error) {
        return undefined;
    }
}

/**
 * Gets the foreground command running in a terminal pane
 * @param panePid Process ID of the pane to inspect
 * @returns Promise resolving to command name or empty string if not found
 */
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
