export type Command = (args?: string[]) => Promise<void>;

export type Commands = {
    [key: string]: Command;
}

