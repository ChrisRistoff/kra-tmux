import { Pane, TmuxSessions, Window } from '@/types/sessionTypes';
import { execSync } from 'child_process';

interface EventContext {
    sessionName: string;
    windowId: number | null;
    paneId: number | null;
    eventString: string;
}

interface TmuxInfo {
    currentCommand: string;
    currentPath: string;
    layout: string;
    gitRepoLink: string;
}

interface PanePosition {
    paneLeft: string;
    paneTop: string;
}

type EventHandler = (sessions: TmuxSessions, context: EventContext) => TmuxSessions;

// utility
const getTmuxInfo = (sessionName: string, windowId: number | null = null, paneId: number | null = null): TmuxInfo => {
    try {
        const target = paneId !== null ? `${sessionName}:${windowId}.${paneId}`
                     : windowId !== null ? `${sessionName}:${windowId}`
                     : sessionName;

        const currentCommand = execSync(`tmux display-message -t "${target}" -p '#{pane_current_command}'`, { encoding: 'utf8' }).trim();
        const currentPath = execSync(`tmux display-message -t "${target}" -p '#{pane_current_path}'`, { encoding: 'utf8' }).trim();
        const layout = windowId !== null ? execSync(`tmux display-message -t "${sessionName}:${windowId}" -p '#{window_layout}'`, { encoding: 'utf8' }).trim() : '';

        return {
            currentCommand,
            currentPath,
            layout,
            gitRepoLink: getGitRepoLink(currentPath)
        };
    } catch (error) {
        console.warn('Error getting tmux info:', (error as Error).message);
        return {
            currentCommand: 'zsh',
            currentPath: process.env.HOME || '/home/user',
            layout: '',
            gitRepoLink: ''
        };
    }
};

const getGitRepoLink = (path: string): string => {
    try {
        const gitRemote = execSync(`cd "${path}" && git config --get remote.origin.url 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
        return gitRemote;
    } catch {
        return '';
    }
};

const getPanePosition = (sessionName: string, windowId: number, paneId: number): PanePosition => {
    try {
        const paneLeft = execSync(`tmux display-message -t "${sessionName}:${windowId}.${paneId}" -p '#{pane_left}'`, { encoding: 'utf8' }).trim();
        const paneTop = execSync(`tmux display-message -t "${sessionName}:${windowId}.${paneId}" -p '#{pane_top}'`, { encoding: 'utf8' }).trim();
        return { paneLeft, paneTop };
    } catch {
        return { paneLeft: '0', paneTop: '0' };
    }
};

const getWindowName = (sessionName: string, windowId: number): string => {
    try {
        return execSync(`tmux display-message -t "${sessionName}:${windowId}" -p '#{window_name}'`, { encoding: 'utf8' }).trim();
    } catch {
        return `window-${windowId}`;
    }
};

// session handlers
const handleSessionCreated: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName } = context;
    if (!sessions[sessionName]) {
        sessions[sessionName] = { windows: [] };
        console.log(`Created new session: ${sessionName}`);
    }
    return sessions;
};

const handleSessionClosed: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName } = context;
    if (sessions[sessionName]) {
        delete sessions[sessionName];
        console.log(`Removed session: ${sessionName}`);
    }
    return sessions;
};

const handleSessionRenamed: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName } = context;
    if (!sessions[sessionName]) {
        sessions[sessionName] = { windows: [] };
    }
    console.log(`Session renamed to: ${sessionName}`);
    return sessions;
};

// window handlers
const handleWindowCreated: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId } = context;

    if (windowId === null) {
        console.warn('Window ID is required for window-created event');
        return sessions;
    }

    if (!sessions[sessionName]) {
        sessions[sessionName] = { windows: [] };
    }

    const session = sessions[sessionName];
    const windowName = getWindowName(sessionName, windowId);
    const existingWindow = session.windows.find(w => w.windowName === windowName);

    if (!existingWindow) {
        const tmuxInfo = getTmuxInfo(sessionName, windowId);
        const newWindow: Window = {
            windowName,
            layout: tmuxInfo.layout,
            gitRepoLink: tmuxInfo.gitRepoLink,
            currentCommand: tmuxInfo.currentCommand,
            currentPath: tmuxInfo.currentPath,
            panes: []
        };
        session.windows.push(newWindow);
        console.log(`Created window ${windowName} in session ${sessionName}`);
    }

    return sessions;
};

const handleWindowRenamed: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId } = context;

    if (windowId === null || !sessions[sessionName]) {
        return sessions;
    }

    const session = sessions[sessionName];
    const newWindowName = getWindowName(sessionName, windowId);
    const window = session.windows.find(w => w.windowName.includes(`${windowId}`) || w.windowName === newWindowName);

    if (window) {
        window.windowName = newWindowName;
        console.log(`Window renamed to ${newWindowName} in session ${sessionName}`);
    }

    return sessions;
};

const handleWindowClosed: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId } = context;

    if (windowId === null || !sessions[sessionName]) {
        return sessions;
    }

    const session = sessions[sessionName];
    const windowIndex = session.windows.findIndex(w =>
        w.windowName.includes(`${windowId}`) || w.windowName === getWindowName(sessionName, windowId)
    );

    if (windowIndex !== -1) {
        const removedWindow = session.windows.splice(windowIndex, 1)[0];
        console.log(`Removed window ${removedWindow.windowName} from session ${sessionName}`);
    }

    return sessions;
};

// pane handlers
const handlePaneCreated: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId, paneId } = context;

    if (windowId === null || paneId === null) {
        console.warn('Window ID and Pane ID are required for pane-created event');
        return sessions;
    }

    if (!sessions[sessionName]) {
        return sessions;
    }

    const session = sessions[sessionName];
    const windowName = getWindowName(sessionName, windowId);
    let window = session.windows.find(w => w.windowName === windowName);

    // create window if it doesn't exist
    if (!window) {
        const updatedSessions = handleWindowCreated(sessions, { sessionName, windowId, paneId: null, eventString: context.eventString });
        window = updatedSessions[sessionName].windows.find(w => w.windowName === windowName);
    }

    if (window) {
        const existingPane = window.panes.length < paneId ? undefined : window.panes[paneId]

        if (!existingPane) {
            const tmuxInfo = getTmuxInfo(sessionName, windowId, paneId);
            const position = getPanePosition(sessionName, windowId, paneId);

            const newPane: Pane = {
                currentCommand: tmuxInfo.currentCommand,
                currentPath: tmuxInfo.currentPath,
                gitRepoLink: tmuxInfo.gitRepoLink,
                paneLeft: position.paneLeft,
                paneTop: position.paneTop
            };
            window.panes.push(newPane);

            // update window layout
            window.layout = tmuxInfo.layout;

            console.log(`Created pane ${paneId} in window ${windowName} of session ${sessionName}`);
        }
    }

    return sessions;
};

const handlePaneClosedOrExited: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId, paneId } = context;

    if (windowId === null || paneId === null || !sessions[sessionName]) {
        return sessions;
    }

    const session = sessions[sessionName];
    const windowName = getWindowName(sessionName, windowId);
    const window = session.windows.find(w => w.windowName === windowName);

    if (window) {
        const existingPane = window.panes.length < paneId ? undefined : window.panes[paneId]


        if (existingPane) {
            window.panes.splice(paneId, 1);

            // update window layout after pane removal
            try {
                const tmuxInfo = getTmuxInfo(sessionName, windowId);
                window.layout = tmuxInfo.layout;
            } catch (error) {
                console.warn('Could not update layout after pane removal:', (error as Error).message);
            }

            console.log(`Removed pane ${paneId} from window ${windowName} of session ${sessionName}`);
        }
    }

    return sessions;
};

const handlePwdChanged: EventHandler = (sessions: TmuxSessions, context: EventContext): TmuxSessions => {
    const { sessionName, windowId, paneId } = context;

    if (windowId === null || paneId === null || !sessions[sessionName]) {
        return sessions;
    }

    const session = sessions[sessionName];
    const windowName = getWindowName(sessionName, windowId);
    const window = session.windows.find(w => w.windowName === windowName);

    if (window) {
        const pane = window.panes.length < paneId ? undefined : window.panes[paneId]


        if (pane) {
            const tmuxInfo = getTmuxInfo(sessionName, windowId, paneId);
            pane.currentPath = tmuxInfo.currentPath;
            pane.currentCommand = tmuxInfo.currentCommand;
            pane.gitRepoLink = tmuxInfo.gitRepoLink;

            window.currentPath = tmuxInfo.currentPath;
            window.currentCommand = tmuxInfo.currentCommand;
            window.gitRepoLink = tmuxInfo.gitRepoLink;

            console.log(`Updated path for pane ${paneId} to: ${tmuxInfo.currentPath}`);
        }
    }

    return sessions;
};

const eventHandlers: Record<string, EventHandler> = {
    'tmux-session-created': handleSessionCreated,
    'tmux-session-closed': handleSessionClosed,
    'tmux-session-renamed': handleSessionRenamed,
    'tmux-window-created': handleWindowCreated,
    'tmux-window-renamed': handleWindowRenamed,
    'tmux-window-closed': handleWindowClosed,
    'tmux-pane-created': handlePaneCreated,
    'tmux-pane-closed': handlePaneClosedOrExited,
    'tmux-pane-exited': handlePaneClosedOrExited,
    'tmux-pwd-changed': handlePwdChanged
};

/**
 * Main entry point for processing events
 */
export const processEvent = (eventString: string, currentSessions: TmuxSessions): TmuxSessions => {
    const parts = eventString.split(':');
    if (parts.length < 3) {
        console.warn('Invalid event string format:', eventString);
        return currentSessions;
    }

    const [source, event, sessionName, windowIdStr, paneIdStr] = parts;

    if (source !== 'tmux') {
        console.warn('Non-tmux event received:', eventString);
        return currentSessions;
    }

    const eventKey = `tmux-${event}`;
    const handler = eventHandlers[eventKey];

    if (!handler) {
        console.warn('No handler for event:', eventKey);
        return currentSessions;
    }

    console.log(`Processing event: ${eventKey} for session: ${sessionName}`);

    // Deep clone to avoid mutation
    const sessions = JSON.parse(JSON.stringify(currentSessions)) as TmuxSessions;

    const context: EventContext = {
        sessionName,
        windowId: windowIdStr ? parseInt(windowIdStr, 10) : null,
        paneId: paneIdStr ? parseInt(paneIdStr, 10) : null,
        eventString
    };

    return handler(sessions, context);
};
