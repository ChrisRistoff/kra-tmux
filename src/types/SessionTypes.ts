import { PaneSplitDirection } from "../enums/SessionEnums"

export type TmuxSessions = {
    [key: string]: {
        windows: Window[]
    }
}

export type Window = {
    windowName: string,
    currentCommand: string,
    gitLink: string,
    currentPath: string,
    width: string,
    height: string,
    panes: Pane[]
}

export type Pane = {
    splitDirection: PaneSplitDirection,
    currentCommand: string,
    currentPath: string,
    height: string,
    width: string,
}

export type DateForFileName = {
    year: string,
    month: string,
    day: string,
    time: string,
}
