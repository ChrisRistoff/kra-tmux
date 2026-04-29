/**
 * Provider registry shared between AIChat and AIAgent (BYOK).
 *
 * All listed providers speak the OpenAI Chat Completions wire format.
 * Mistral exposes an OpenAI-compatible endpoint at https://api.mistral.ai/v1,
 * so it lives here too — no separate SDK path is needed.
 *
 * Adding a new provider: add it to SUPPORTED_PROVIDERS, add a baseURL case
 * in getProviderBaseURL, an apiKey case in getProviderApiKey, and (optionally)
 * a live fetcher branch in modelCatalog.ts.
 */

import * as keys from '@/AI/AIChat/data/keys';

export const SUPPORTED_PROVIDERS = [
    'deep-infra',
    'open-code',
    'deep-seek',
    'open-router',
    'gemini',
    'open-ai',
    'mistral',
] as const;

export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

export function getProviderBaseURL(provider: string): string {
    switch (provider) {
        case 'open-code':
            return 'https://opencode.ai/zen/go/v1';
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
        case 'mistral':
            return 'https://api.mistral.ai/v1';
        default:
            throw new Error(`Provider '${provider}' has no configured baseURL.`);
    }
}

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
        case 'mistral':
            return keys.getMistralKey();
        case 'open-code':
            return keys.getOpenCodeKey();
        case 'open-ai': {
            const fromEnv = process.env['OPENAI_API_KEY'];

            if (!fromEnv) {
                throw new Error('OPENAI_API_KEY environment variable is not set');
            }

            return fromEnv;
        }
        default:
            throw new Error(`Provider '${provider}' has no configured API key getter.`);
    }
}
