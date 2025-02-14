import dotenv from 'dotenv';

dotenv.config();

export function getClaudeKey(): string {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }

    return apiKey;
}

export function getDeepInfraKey(): string {
    const apiKey = process.env.DEEP_INFRA;

    if (!apiKey) {
        throw new Error('DEEP_INFRA environment variable is not set');
    }

    return apiKey;
}

export function getGeminiKey(): string {
    const apiKey = process.env.GEMINI;

    if (!apiKey) {
        throw new Error('GEMINI environment variable is not set');
    }

    return apiKey;
}

export function getDeepSeekKey(): string {
    const apiKey = process.env.DEEP_SEEK;

    if (!apiKey) {
        throw new Error('DEEP_SEEK environment variable is not set');
    }

    return apiKey;
}

export function getOpenRouterKey(): string {
    const apiKey = process.env.OPEN_ROUTER;

    if (!apiKey) {
        throw new Error('OPEN_ROUTER environment variable is not set');
    }

    return apiKey;
}

export function getMistralKey(): string {
    const apiKey = process.env.MISTRAL;

    if (!apiKey) {
        throw new Error('MISTRAL environment variable is not set');
    }

    return apiKey;
}
