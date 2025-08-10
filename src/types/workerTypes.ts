import { Window } from "./sessionTypes";

export type SessionWorkerData = {
    sessionName: string;
    sessionData: any;
    fileName: string;
}

export type WorkerResult = {
    sessionName: string;
    windows: Window[]
    success: boolean;
    error?: string;
}
