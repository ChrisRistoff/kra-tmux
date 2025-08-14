export type SessionWorkerData = {
    sessionName: string;
    sessionData: any;
    fileName: string;
}

export type WorkerResult = {
    sessionName: string;
    success: boolean;
    error?: string;
}
