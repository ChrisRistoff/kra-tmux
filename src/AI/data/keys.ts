import dotenv from 'dotenv';

dotenv.config();

export function getClaudeKey(): string {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
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
