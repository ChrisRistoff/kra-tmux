export type GitCommand = (args?: string[]) => Promise<void>;

export type GitCommands = {
    [key: string]: GitCommand;
}

export type GitSearchOptions = {
    prompt: string;
    itemsArray: string[];
    header?: string;
    details?: (item: string, index: number) => string | Promise<string>;
    selected?: string;
    showDetailsPanel?: boolean;
}

export type PathInfoObject = {
    [key: string]: string;
}

export type Conflicts = {
    [key: string]: string;
}
