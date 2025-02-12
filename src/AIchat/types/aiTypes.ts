
export type AiRoles = {
    [key: string]: string,
}

export type Models = {
    [key: string]: string,
}

export type Providers = {
    [key: string]: Models,
}

export type ChatModelDetails = {
    provider: string,
    model: string
}
