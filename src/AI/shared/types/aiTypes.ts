export enum Role {
    User = 'USER',
    AI = 'AI',
}

export interface StreamController {
    abort: () => void;
    isAborted: boolean;
}

export interface FileContext {
    filePath: string;
    isPartial: boolean;
    startLine?: number | undefined;
    endLine?: number | undefined;
    summary: string;
}

export interface AiRoles {
    [key: string]: string,
}

export interface Models {
    [key: string]: string,
}

export interface Providers {
    [key: string]: Models,
}

export interface ChatModelDetails {
    provider: string,
    model: string
}

export interface ChatHistory {
    role: Role,
    message: string,
    timestamp: string,
}

export interface SavedFileContext {
    filePath: string;
    isPartial: boolean;
    startLine?: number;
    endLine?: number;
}

export interface ChatData {
    title?: string,
    summary?: string,
    provider: string,
    model: string,
    role: string,
    temperature: number,
    chatHistory: ChatHistory[],
    fileContexts?: SavedFileContext[] | undefined
}
