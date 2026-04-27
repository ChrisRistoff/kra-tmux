/**
 * Live model catalog — shared between AIChat and AIAgent (BYOK).
 *
 * Fetches the available models for each provider directly from the provider's
 * HTTP API at session-start time, attaching whatever metadata the provider
 * exposes (context window, per-token pricing). For providers whose model-list
 * endpoint does not include such metadata, a small static fallback table fills
 * in the well-known values.
 *
 * Results are cached on disk under `~/.kra/model-catalog/<provider>.json`
 * with a 24-hour TTL. On network failure we return the most recently cached
 * snapshot (even if expired) and only fall through to the built-in static
 * lists if no cache exists.
 *
 * The catalog is the single source of truth for provider models — for both
 * the AIChat picker and the BYOK agent picker. It also provides the
 * context-window number that drives proactive compaction in
 * `byokSession.streamOnePass`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { kraHome } from '@/filePaths';
import {
    type SupportedProvider,
    getProviderApiKey,
} from '@/AI/shared/data/providers';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ModelPricing {
    inputPerM: number;
    outputPerM: number;
    cachedInputPerM?: number;
}

export interface ModelInfo {
    id: string;
    label: string;
    contextWindow: number;
    pricing?: ModelPricing;
}

export interface CatalogFetchOptions {
    forceRefresh?: boolean;
}

// ─── Cache layout ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
    fetchedAt: number;
    models: ModelInfo[];
}

function cacheDir(): string {
    return path.join(kraHome(), 'model-catalog');
}

function cachePath(provider: SupportedProvider): string {
    return path.join(cacheDir(), `${provider}.json`);
}

function readCache(provider: SupportedProvider): CacheEntry | undefined {
    try {
        const raw = fs.readFileSync(cachePath(provider), 'utf8');
        const parsed = JSON.parse(raw) as CacheEntry;

        if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
            return undefined;
        }

        return parsed;
    } catch {
        return undefined;
    }
}

function writeCache(provider: SupportedProvider, models: ModelInfo[]): void {
    try {
        fs.mkdirSync(cacheDir(), { recursive: true });

        const entry: CacheEntry = { fetchedAt: Date.now(), models };

        fs.writeFileSync(cachePath(provider), JSON.stringify(entry, null, 2), 'utf8');
    } catch {
        // best-effort; not fatal
    }
}

// ─── Static fallback metadata ────────────────────────────────────────────────

const STATIC_DEEPSEEK: Record<string, { contextWindow: number; pricing: ModelPricing }> = {
    'deepseek-chat': { contextWindow: 128_000, pricing: { inputPerM: 0.27, outputPerM: 1.10, cachedInputPerM: 0.07 } },
    'deepseek-reasoner': { contextWindow: 128_000, pricing: { inputPerM: 0.55, outputPerM: 2.19, cachedInputPerM: 0.14 } },
};

const STATIC_OPENAI: Record<string, { contextWindow: number; pricing: ModelPricing }> = {
    'gpt-4o': { contextWindow: 128_000, pricing: { inputPerM: 2.50, outputPerM: 10.00, cachedInputPerM: 1.25 } },
    'gpt-4o-mini': { contextWindow: 128_000, pricing: { inputPerM: 0.15, outputPerM: 0.60, cachedInputPerM: 0.075 } },
    'o1-mini': { contextWindow: 128_000, pricing: { inputPerM: 1.10, outputPerM: 4.40 } },
    'o3-mini': { contextWindow: 200_000, pricing: { inputPerM: 1.10, outputPerM: 4.40 } },
    'gpt-5-mini': { contextWindow: 400_000, pricing: { inputPerM: 0.25, outputPerM: 2.00 } },
};

const STATIC_GEMINI_PRICES: Record<string, ModelPricing> = {
    'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.00 },
    'gemini-2.5-flash': { inputPerM: 0.30, outputPerM: 2.50 },
    'gemini-2.5-flash-lite': { inputPerM: 0.10, outputPerM: 0.40 },
};

const STATIC_MISTRAL: Record<string, { contextWindow: number; pricing: ModelPricing }> = {
    'mistral-large-latest': { contextWindow: 128_000, pricing: { inputPerM: 2.00, outputPerM: 6.00 } },
    'mistral-small-latest': { contextWindow: 128_000, pricing: { inputPerM: 0.20, outputPerM: 0.60 } },
    'codestral-latest': { contextWindow: 256_000, pricing: { inputPerM: 0.30, outputPerM: 0.90 } },
    'open-mistral-nemo': { contextWindow: 128_000, pricing: { inputPerM: 0.15, outputPerM: 0.15 } },
    'open-mixtral-8x22b': { contextWindow: 64_000, pricing: { inputPerM: 2.00, outputPerM: 6.00 } },
};

const STATIC_FALLBACK_MODELS: Record<SupportedProvider, ModelInfo[]> = {
    'deep-infra': [
        { id: 'moonshotai/Kimi-K2-Instruct', label: 'moonshotai/Kimi-K2-Instruct', contextWindow: 128_000, pricing: { inputPerM: 0.75, outputPerM: 4.00, cachedInputPerM: 0.15 } },
        { id: 'deepseek-ai/DeepSeek-V3', label: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000, pricing: { inputPerM: 0.27, outputPerM: 1.10 } },
        { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', label: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', contextWindow: 256_000, pricing: { inputPerM: 0.40, outputPerM: 1.60 } },
    ],
    'deep-seek': [
        { id: 'deepseek-chat', label: 'deepseek-chat', contextWindow: 128_000, pricing: STATIC_DEEPSEEK['deepseek-chat'].pricing },
        { id: 'deepseek-reasoner', label: 'deepseek-reasoner', contextWindow: 128_000, pricing: STATIC_DEEPSEEK['deepseek-reasoner'].pricing },
    ],
    'open-router': [
        { id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini', contextWindow: 128_000, pricing: { inputPerM: 0.15, outputPerM: 0.60 } },
        { id: 'anthropic/claude-3.5-sonnet', label: 'anthropic/claude-3.5-sonnet', contextWindow: 200_000, pricing: { inputPerM: 3.00, outputPerM: 15.00 } },
    ],
    'gemini': [
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', contextWindow: 1_048_576, pricing: STATIC_GEMINI_PRICES['gemini-2.5-pro'] },
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', contextWindow: 1_048_576, pricing: STATIC_GEMINI_PRICES['gemini-2.5-flash'] },
    ],
    'open-ai': [
        { id: 'gpt-4o', label: 'gpt-4o', contextWindow: 128_000, pricing: STATIC_OPENAI['gpt-4o'].pricing },
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini', contextWindow: 128_000, pricing: STATIC_OPENAI['gpt-4o-mini'].pricing },
    ],
    'mistral': [
        { id: 'mistral-large-latest', label: 'mistral-large-latest', contextWindow: 128_000, pricing: STATIC_MISTRAL['mistral-large-latest'].pricing },
        { id: 'mistral-small-latest', label: 'mistral-small-latest', contextWindow: 128_000, pricing: STATIC_MISTRAL['mistral-small-latest'].pricing },
        { id: 'codestral-latest', label: 'codestral-latest', contextWindow: 256_000, pricing: STATIC_MISTRAL['codestral-latest'].pricing },
    ],
};

// ─── Per-provider live fetchers ──────────────────────────────────────────────

interface OpenRouterModel {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
}

async function fetchOpenRouter(): Promise<ModelInfo[]> {
    const res = await fetch('https://openrouter.ai/api/v1/models');

    if (!res.ok) {
        throw new Error(`OpenRouter /models returned ${res.status}`);
    }

    const json = await res.json() as { data: OpenRouterModel[] };
    const dollarPerToken = (s?: string): number | undefined => {
        if (!s) {
            return undefined;
        }

        const n = Number(s);

        return Number.isFinite(n) ? n : undefined;
    };

    return json.data.map((m): ModelInfo => {
        const inputPerToken = dollarPerToken(m.pricing?.prompt);
        const outputPerToken = dollarPerToken(m.pricing?.completion);
        const cachedPerToken = dollarPerToken(m.pricing?.input_cache_read);
        const pricing: ModelPricing | undefined =
            inputPerToken !== undefined && outputPerToken !== undefined
                ? {
                    inputPerM: inputPerToken * 1_000_000,
                    outputPerM: outputPerToken * 1_000_000,
                    ...(cachedPerToken !== undefined ? { cachedInputPerM: cachedPerToken * 1_000_000 } : {}),
                }
                : undefined;

        return {
            id: m.id,
            label: m.name ?? m.id,
            contextWindow: m.context_length ?? 0,
            ...(pricing ? { pricing } : {}),
        };
    });
}

interface DeepInfraModel {
    model_name: string;
    type?: string;
    max_tokens?: number;
    pricing?: {
        type?: string;
        cents_per_input_token?: number;
        cents_per_output_token?: number;
    };
}

async function fetchDeepInfra(): Promise<ModelInfo[]> {
    const res = await fetch('https://api.deepinfra.com/models/list');

    if (!res.ok) {
        throw new Error(`DeepInfra /models/list returned ${res.status}`);
    }

    const json = await res.json() as DeepInfraModel[];

    return json
        .filter((m) => m.type === 'text-generation')
        .map((m): ModelInfo => {
            const inputCents = m.pricing?.cents_per_input_token;
            const outputCents = m.pricing?.cents_per_output_token;
            const pricing: ModelPricing | undefined =
                typeof inputCents === 'number' && typeof outputCents === 'number'
                    ? {
                        inputPerM: inputCents * 10_000,
                        outputPerM: outputCents * 10_000,
                    }
                    : undefined;

            return {
                id: m.model_name,
                label: m.model_name,
                contextWindow: m.max_tokens ?? 0,
                ...(pricing ? { pricing } : {}),
            };
        });
}

async function fetchDeepSeek(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch('https://api.deepseek.com/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
        throw new Error(`DeepSeek /models returned ${res.status}`);
    }

    const json = await res.json() as { data: Array<{ id: string }> };

    return json.data.map((m): ModelInfo => {
        const meta = STATIC_DEEPSEEK[m.id];

        return {
            id: m.id,
            label: m.id,
            contextWindow: meta.contextWindow ?? 0,
            ...(meta ? { pricing: meta.pricing } : {}),
        };
    });
}

interface GeminiModel {
    name: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
}

async function fetchGemini(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );

    if (!res.ok) {
        throw new Error(`Gemini /models returned ${res.status}`);
    }

    const json = await res.json() as { models: GeminiModel[] };

    return json.models
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m): ModelInfo => {
            const id = m.name.replace(/^models\//, '');
            const pricing = STATIC_GEMINI_PRICES[id];

            return {
                id,
                label: m.displayName ?? id,
                contextWindow: m.inputTokenLimit ?? 0,
                ...(pricing ? { pricing } : {}),
            };
        });
}

async function fetchOpenAI(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
        throw new Error(`OpenAI /models returned ${res.status}`);
    }

    const json = await res.json() as { data: Array<{ id: string }> };

    return json.data.map((m): ModelInfo => {
        const meta = STATIC_OPENAI[m.id];

        return {
            id: m.id,
            label: m.id,
            contextWindow: meta.contextWindow || 0,
            ...(meta ? { pricing: meta.pricing } : {}),
        };
    });
}

async function fetchMistral(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
        throw new Error(`Mistral /models returned ${res.status}`);
    }

    const json = await res.json() as { data: Array<{ id: string; max_context_length?: number }> };

    return json.data.map((m): ModelInfo => {
        const meta = STATIC_MISTRAL[m.id];

        return {
            id: m.id,
            label: m.id,
            contextWindow: m.max_context_length ?? meta.contextWindow ?? 0,
            ...(meta.pricing ? { pricing: meta.pricing } : {}),
        };
    });
}

async function fetchLive(provider: SupportedProvider): Promise<ModelInfo[]> {
    switch (provider) {
        case 'open-router':
            return fetchOpenRouter();
        case 'deep-infra':
            return fetchDeepInfra();
        case 'deep-seek':
            return fetchDeepSeek(getProviderApiKey(provider));
        case 'gemini':
            return fetchGemini(getProviderApiKey(provider));
        case 'open-ai':
            return fetchOpenAI(getProviderApiKey(provider));
        case 'mistral':
            return fetchMistral(getProviderApiKey(provider));
        default: {
            const exhaustive: never = provider;

            throw new Error(`No live fetcher for provider '${exhaustive as string}'`);
        }
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getModelCatalog(
    provider: SupportedProvider,
    opts: CatalogFetchOptions = {}
): Promise<ModelInfo[]> {
    if (!opts.forceRefresh) {
        const cached = readCache(provider);

        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.models;
        }
    }

    try {
        const models = await fetchLive(provider);

        if (models.length > 0) {
            writeCache(provider, models);

            return models;
        }
    } catch {
        // fall through to stale cache / static fallback
    }

    const stale = readCache(provider);

    if (stale) {
        return stale.models;
    }

    return STATIC_FALLBACK_MODELS[provider];
}

export function formatModelInfoForPicker(modelInfo: ModelInfo): string {
    const ctxStr = modelInfo.contextWindow > 0
        ? `${Math.round(modelInfo.contextWindow / 1000)}k ctx`.padEnd(10)
        : '? ctx    '.padEnd(10);

    const priceStr = modelInfo.pricing
        ? `$${modelInfo.pricing.inputPerM.toFixed(2)}/$${modelInfo.pricing.outputPerM.toFixed(2)} in/out` +
        (modelInfo.pricing.cachedInputPerM !== undefined
            ? `  cached $${modelInfo.pricing.cachedInputPerM.toFixed(2)}`
            : '')
        : '? pricing';

    const label = modelInfo.label.padEnd(48);

    return `${label}  ${ctxStr}  ${priceStr}`;
}
