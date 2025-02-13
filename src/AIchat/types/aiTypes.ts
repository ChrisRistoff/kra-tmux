
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
