export type TmuxSessions = {
    [key: string]: {
        windows: Window[]
    }
}

export type Window = {
    windowName: string,
    currentCommand: string,
    layout: string,
    currentPath: string,
    gitRepoLink: string,
    panes: Pane[]
}

export type Pane = {
    currentCommand: string,
    currentPath: string,
    gitRepoLink: string,
    paneLeft: string,
    paneTop: string,
}

export type DateForFileName = {
    year: string,
    month: string,
    day: string,
    time: string,
}
