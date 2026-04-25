/**
 * Maps AIChat provider names to their OpenAI-compatible base URLs.
 *
 * Mirrors the switch in `src/AI/AIChat/utils/promptModel.ts` but only lists
 * providers that:
 *   1. Speak the OpenAI Chat Completions wire format, AND
 *   2. Have models suitable for tool-calling agents.
 *
 * Mistral is intentionally excluded — it uses its own SDK in promptModel.ts.
 * Copilot is excluded — that path is the dedicated providers/copilot/ flow.
 */
export function getProviderBaseURL(provider: string): string {
    switch (provider) {
        case 'deep-infra':
            return 'https://api.deepinfra.com/v1/openai';
        case 'deep-seek':
            return 'https://api.deepseek.com/v1';
        case 'open-router':
            return 'https://openrouter.ai/api/v1';
        case 'gemini':
            return 'https://generativelanguage.googleapis.com/v1beta/openai/';
        case 'open-ai':
            return 'https://api.openai.com/v1';
        default:
            throw new Error(`BYOK provider '${provider}' has no configured baseURL.`);
    }
}

import * as keys from '@/AI/AIChat/data/keys';

export function getProviderApiKey(provider: string): string {
    switch (provider) {
        case 'deep-infra':
            return keys.getDeepInfraKey();
        case 'deep-seek':
            return keys.getDeepSeekKey();
        case 'open-router':
            return keys.getOpenRouterKey();
        case 'gemini':
            return keys.getGeminiKey();
        case 'open-ai': {
            const fromEnv = process.env['OPENAI_API_KEY'];

            if (!fromEnv) {
                throw new Error('OPENAI_API_KEY environment variable is not set');
            }

            return fromEnv;
        }
        default:
            throw new Error(`BYOK provider '${provider}' has no configured API key getter.`);
    }
}

export const SUPPORTED_BYOK_PROVIDERS = [
    'deep-infra',
    'deep-seek',
    'open-router',
    'gemini',
    'open-ai',
] as const;

export type SupportedByokProvider = typeof SUPPORTED_BYOK_PROVIDERS[number];
