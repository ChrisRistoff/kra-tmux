export enum Role {
    User = 'USER',
    AI = 'AI',
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
