export type Command = (args?: string[]) => Promise<void>;

export interface CommandDefinition {
    run: Command;
    description: string;
    details?: string;
    highlights?: readonly string[];
}

export type CommandCatalog<T extends string> = Record<T, CommandDefinition>;

export type SystemCommandName = 'grep-file-remove' | 'grep-dir-remove' | 'scripts';
export type TmuxCommandName = 'save-server' | 'load-server' | 'list-sessions' | 'manage-server' | 'kill';
export type GitCommandName =
    | 'restore'
    | 'cache-untracked'
    | 'retrieve-untracked'
    | 'hard-reset'
    | 'log'
    | 'stash'
    | 'stash-drop-multiple'
    | 'conflict-handle'
    | 'view-changed'
    | 'open-pr'
    | 'create-branch'
    | 'checkout';
export type AiCommandName =
    | 'chat'
    | 'agent'
    | 'load'
    | 'delete'
    | 'quota-agent'
    | 'index'
    | 'memory'
    | 'docs';
export type CommandType = 'sys' | 'tmux' | 'git' | 'ai' | 'settings';

export type SystemCommands = CommandCatalog<SystemCommandName>;
export type TmuxCommands = CommandCatalog<TmuxCommandName>;
export type GitCommands = CommandCatalog<GitCommandName>;
export type AiCommands = CommandCatalog<AiCommandName>;

export interface MenuOption<T extends string> {
    name: T;
    description: string;
    details?: string;
    highlights?: readonly string[];
}