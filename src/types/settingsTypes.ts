type WatchOptions = {
    active: boolean,
    watch: {
        windowName: string,
        command: string,
    }
}

type Autosave = {
    active: boolean,
    currentSession: string,
    timeoutMs: number,
}

export type Settings = {
    watchCommands: {
        work: WatchOptions,
        personal: WatchOptions,
    },

    autosave: Autosave
}
