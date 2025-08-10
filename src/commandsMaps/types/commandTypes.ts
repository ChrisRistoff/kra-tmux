export type Command = (args?: string[]) => Promise<void>;

export type SystemCommandName = {
    'grep-file-remove': Command,
    'grep-dir-remove': Command,
    'scripts': Command,
}

type TmuxCommandName = {
    'save-server': Command,
    'load-server': Command,
    'list-sessions': Command,
    'delete-server': Command,
    'kill': Command,
    'quicksave': Command,
};

export type GitCommandName = {
    'restore': Command,
    'cache-untracked': Command,
    'retrieve-untracked': Command,
    'hard-reset': Command,
    'log': Command,
    'stash': Command,
    'stash-drop-multiple': Command,
    'conflict-handle': Command,
    'view-changed': Command,
    'open-pr': Command,
    'create-branch': Command,
    'checkout': Command,
}

export type AiCommandName = {
    'chat': Command,
    'load': Command,
    'delete': Command,
}

export type SystemCommands = Record<keyof SystemCommandName, Command>;
export type TmuxCommands = Record<keyof TmuxCommandName, Command>;
export type GitCommands = Record<keyof GitCommandName, Command>;
export type AiCommands = Record<keyof AiCommandName, Command>;
