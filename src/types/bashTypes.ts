export type AllowedCommandsForNoCode = {
    [key: string]: Set<string>;
}

export type SendKeysArguments = {
    sessionName?: string
    windowIndex?: number
    paneIndex?: number
    command: string,
}
