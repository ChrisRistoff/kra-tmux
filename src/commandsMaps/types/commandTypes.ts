export type Command = (args?: string[]) => Promise<void>;

export interface CommandDefinition {
    run: Command;
    description: string;
    details?: string;
    highlights?: readonly string[];
}

export type CommandCatalog<T extends string> = Record<T, CommandDefinition>;

export type SystemCommandName = 'grep' | 'scripts' | 'process-manager' | 'disk-usage';
export type TmuxCommandName = 'save-server' | 'load-server' | 'save-session' | 'load-session' | 'list-sessions' | 'manage-saves' | 'find-session' | 'kill';
export type NotesCommandName = 'open' | 'new' | 'pick' | 'journal';
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
    | 'checkout'
    | 'reflog'
    | 'scout';
export type AiCommandName =
    | 'chat'
    | 'agent'
    | 'load'
    | 'delete'
    | 'quota-agent'
    | 'index';
export type CommandType = 'sys' | 'tmux' | 'git' | 'ai' | 'memory' | 'settings' | 'notes';

export type SystemCommands = CommandCatalog<SystemCommandName>;
export type TmuxCommands = CommandCatalog<TmuxCommandName>;
export type NotesCommands = CommandCatalog<NotesCommandName>;
export type GitCommands = CommandCatalog<GitCommandName>;
export type AiCommands = CommandCatalog<AiCommandName>;

export interface MenuOption<T extends string> {
    name: T;
    description: string;
    details?: string;
    highlights?: readonly string[];
}
