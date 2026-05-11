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
    reasoningPerM?: number;
}

export interface ModelCapabilities {
    /** Whether the model supports reasoning / thinking tokens. */
    reasoning: boolean;
    /**
     * Which field in streaming deltas carries interleaved reasoning content.
     * - `'reasoning_content'` → DeepSeek-style
     * - `'reasoning_details'` → Gemini/Google-style structured reasoning
     * - `undefined` → reasoning not supported or uses raw `reasoning` delta
     *
     * The BYOK session inspects this to know which delta fields to watch for
     * reasoning output so it can route it to `assistant.reasoning_delta`.
     */
    reasoningField?: 'reasoning_content' | 'reasoning_details';
    /** Whether the model supports tool / function calling. */
    toolCall: boolean;
    /** Whether the `temperature` parameter is accepted. */
    temperature: boolean;
    /** Whether the model supports structured / JSON output. */
    structuredOutput: boolean;
    /** Whether the model accepts file attachments (images, PDFs, etc). */
    attachment: boolean;
    /** Input modalities the model supports (e.g. 'text', 'image', 'audio'). */
    inputModalities: string[];
    /** Output modalities the model supports (e.g. 'text', 'audio'). */
    outputModalities: string[];
    /** Reasoning cost per million tokens (if separate from output cost). */
    reasoningCostPerM?: number;
    /** Knowledge cutoff date (e.g. '2025-04'). */
    knowledge?: string;
    /** When the model was released. */
    releaseDate?: string;
    /** Model family (e.g. 'gpt', 'claude', 'deepseek'). */
    family?: string;
    /** Whether the model has open weights. */
    /** Whether the model has open weights. */
    openWeights?: boolean;
    /**
     * Per-parameter descriptors merged from `BUILTIN_PARAM_DESCRIPTORS` and
     * overlaid with provider/model `canSend` flags from models.dev (Phase 3
     * of the BYOK parameter overhaul). Keyed by the OpenAI Chat Completions
     * API parameter name (e.g. `temperature`, `reasoning_effort`, `top_p`).
     *
     * The picker (`pickByokRuntime` → `renderDynamicParamPicker`) iterates
     * this map to build the per-session `dynamicParams` payload, skipping
     * descriptors with `canSend === false`.
     */
    supportedParams?: Record<string, ParamDescriptor>;
}

/**
 * Describes a single optional Chat Completions parameter so the BYOK picker
 * can render a UI for it without hardcoding per-param logic.
 *
 * Lives in source code (not on models.dev) because models.dev only exposes a
 * handful of boolean capability flags — it does NOT carry per-param
 * type/min/max metadata. The `canSend` flag is the bridge: models.dev
 * boolean flags overlay onto our descriptor table to disable specific keys
 * per model (e.g. `temperature: false`).
 */
export interface ParamDescriptor {
    /** Picker label, e.g. 'Reasoning effort'. */
    label: string;
    /** Optional longer description shown in details. */
    description?: string;
    /** Discriminator for the picker dispatch. */
    type: 'number' | 'enum' | 'boolean' | 'string';
    /** OpenAI Chat Completions API key sent in the request body. */
    apiKey: string;
    /** Default value (informational; picker may surface in the prompt). */
    defaultValue?: unknown;
    /** Allowed enum values when `type === 'enum'`. */
    enumValues?: readonly string[];
    /** Inclusive minimum when `type === 'number'`. */
    min?: number;
    /** Inclusive maximum when `type === 'number'`. */
    max?: number;
    /** Step / increment when `type === 'number'`. */
    step?: number;
    /**
     * When false, the picker skips this descriptor entirely. Used by the
     * models.dev overlay to disable params the model is known to reject
     * without removing the descriptor from the registry.
     */
    canSend?: boolean;
    /**
     * How to encode the value when sending to the provider.
     *   - `'literal'`: send the picker value unchanged (e.g. `reasoning_effort: 'medium'`).
     *   - `'boolean'`: coerce any non-null picker value to `true`. Used for BYOK
     *     proxies that accept the param as a plain on/off boolean.
     * The picker also dispatches UX off this field: `'literal'` shows the enum
     * picker; `'boolean'` shows a yes/no toggle.
     */
    sendAs?: 'literal' | 'boolean';
}

/**
 * Source-of-truth registry of optional Chat Completions parameters the BYOK
 * picker knows how to prompt for. New parameters added here automatically
 * surface in the picker (Phase 3) and become candidates for the dynamic
 * `OPTIONAL_PARAMS` strip-and-retry registry consumed by `byokSession.ts`.
 */
export const BUILTIN_PARAM_DESCRIPTORS: Readonly<Record<string, ParamDescriptor>> = {
    reasoning_effort: {
        label: 'Reasoning effort',
        description: 'How much the model should think before responding.',
        type: 'enum',
        apiKey: 'reasoning_effort',
        enumValues: ['low', 'medium', 'high'],
        defaultValue: 'medium',
    },
    temperature: {
        label: 'Temperature',
        description: 'Sampling temperature. Lower = more deterministic.',
        type: 'number',
        apiKey: 'temperature',
        min: 0,
        max: 2,
        step: 0.1,
        defaultValue: 1,
    },
    top_p: {
        label: 'Top-p',
        description: 'Nucleus sampling probability mass.',
        type: 'number',
        apiKey: 'top_p',
        min: 0,
        max: 1,
        step: 0.1,
        defaultValue: 1,
    },
    frequency_penalty: {
        label: 'Frequency penalty',
        description: 'Penalises repeated tokens by frequency.',
        type: 'number',
        apiKey: 'frequency_penalty',
        min: -2,
        max: 2,
        step: 0.1,
        defaultValue: 0,
    },
    presence_penalty: {
        label: 'Presence penalty',
        description: 'Penalises tokens already present in the response.',
        type: 'number',
        apiKey: 'presence_penalty',
        min: -2,
        max: 2,
        step: 0.1,
        defaultValue: 0,
    },
};

export interface ModelInfo {
    id: string;
    label: string;
    contextWindow: number;
    pricing?: ModelPricing;
    capabilities?: ModelCapabilities;
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

// OpenCode Zen — pricing/context from https://opencode.ai/docs/zen.
// Only the openai-compatible models are reachable via /chat/completions and listed here.
// `-pro` / `-thinking` style suffixes denote reasoning-on variants (selected by model id, not a flag).
const STATIC_OPENCODE: Record<string, { contextWindow: number; pricing?: ModelPricing }> = {
    'minimax-m2.7': { contextWindow: 205_000, pricing: { inputPerM: 0.30, outputPerM: 1.20, cachedInputPerM: 0.06 } },
    'minimax-m2.5': { contextWindow: 205_000, pricing: { inputPerM: 0.30, outputPerM: 1.20, cachedInputPerM: 0.06 } },
    'minimax-m2.5-free': { contextWindow: 205_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'kimi-k2.6': { contextWindow: 262_144, pricing: { inputPerM: 0.95, outputPerM: 4.00, cachedInputPerM: 0.16 } },
    'glm-5.1': { contextWindow: 200_000, pricing: { inputPerM: 1.40, outputPerM: 4.40, cachedInputPerM: 0.26 } },
    'glm-5': { contextWindow: 200_000, pricing: { inputPerM: 1.00, outputPerM: 3.20, cachedInputPerM: 0.20 } },
    'qwen3.6-plus': { contextWindow: 256_000, pricing: { inputPerM: 0.50, outputPerM: 3.00, cachedInputPerM: 0.05 } },
    'big-pickle': { contextWindow: 200_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'hy3-preview-free': { contextWindow: 200_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'ling-2.6-flash-free': { contextWindow: 200_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'nemotron-3-super-free': { contextWindow: 200_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'trinity-large-preview-free': { contextWindow: 200_000, pricing: { inputPerM: 0, outputPerM: 0 } },
};

// Oxlo — https://api.oxlo.ai/v1/models
// Pricing and context from the /models endpoint; static entries provide fallback data.
const STATIC_OXLO: Record<string, { contextWindow: number; pricing?: ModelPricing }> = {
    'deepseek-r1-70b': { contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'llama-3.3-70b': { contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    'kimi-k2-thinking': { contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
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
    'open-code': [
        { id: 'kimi-k2.6', label: 'kimi-k2.6', contextWindow: 262_144, pricing: STATIC_OPENCODE['kimi-k2.6'].pricing! },
        { id: 'glm-5.1', label: 'glm-5.1', contextWindow: 200_000, pricing: STATIC_OPENCODE['glm-5.1'].pricing! },
        { id: 'minimax-m2.7', label: 'minimax-m2.7', contextWindow: 205_000, pricing: STATIC_OPENCODE['minimax-m2.7'].pricing! },
        { id: 'qwen3.6-plus', label: 'qwen3.6-plus', contextWindow: 256_000, pricing: STATIC_OPENCODE['qwen3.6-plus'].pricing! },
    ],
    'oxlo': [
        { id: 'deepseek-r1-70b', label: 'deepseek-r1-70b', contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
        { id: 'llama-3.3-70b', label: 'llama-3.3-70b', contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
        { id: 'kimi-k2-thinking', label: 'kimi-k2-thinking', contextWindow: 32_000, pricing: { inputPerM: 0, outputPerM: 0 } },
    ],
    'crof': [
        { id: 'crof-mini', label: 'crof-mini', contextWindow: 32_000 },
        { id: 'crof-standard', label: 'crof-standard', contextWindow: 128_000 },
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
            contextWindow: meta?.contextWindow ?? 0,
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
            contextWindow: meta?.contextWindow || 0,
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
            contextWindow: m.max_context_length ?? meta?.contextWindow ?? 0,
            ...(meta?.pricing ? { pricing: meta.pricing } : {}),
        };
    });
}

async function fetchOpenCode(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch('https://opencode.ai/zen/go/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
        throw new Error(`OpenCode /models returned ${res.status}`);
    }

    const json = await res.json() as { data: Array<{ id: string }> };

    const models = json.data.map((m): ModelInfo => {
        let meta = STATIC_OPENCODE[m.id];

        if (!meta) {
            meta = {
                contextWindow: 200_000,
                pricing: { inputPerM: 0, outputPerM: 0 },
            };
        };

        return {
            id: m.id,
            label: m.id,
            contextWindow: meta.contextWindow,
            ...(meta.pricing),
        };
    })

    return models;
}

async function fetchOxlo(apiKey: string): Promise<ModelInfo[]> {
    const res = await fetch('https://api.oxlo.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
        throw new Error(`Oxlo /models returned ${res.status}`);
    }

    const json = await res.json() as { data: Array<{ id: string; context_length?: number }> };

    return json.data.map((m): ModelInfo => {
        const meta = STATIC_OXLO[m.id];

        return {
            id: m.id,
            label: m.id,
            contextWindow: m.context_length ?? meta?.contextWindow ?? 0,
            ...(meta?.pricing ? { pricing: meta.pricing } : {}),
        };
    });
}

interface CrofModel {
    id: string;
    name?: string;
    context_length?: number;
    context_window?: number;
    max_completion_tokens?: number;
    /** Whether the model accepts the `reasoning_effort` parameter. */
    reasoning_effort?: boolean;
    /** Whether the model has its own (non-OpenAI-style) reasoning capability. */
    custom_reasoning?: boolean;
    pricing?: {
        prompt?: string | number;
        completion?: string | number;
        cache_prompt?: string | number;
    };
}

async function fetchCrof(): Promise<ModelInfo[]> {
    const res = await fetch('https://crof.ai/v1/models');

    if (!res.ok) {
        throw new Error(`Crof models returned ${res.status}`);
    }

    const json = await res.json() as { data: CrofModel[] };

    return json.data.map((m): ModelInfo => {
        const reasoning = m.reasoning_effort === true || m.custom_reasoning === true;

        const supportedParams: Record<string, ParamDescriptor> = {};
        for (const [key, desc] of Object.entries(BUILTIN_PARAM_DESCRIPTORS)) {
            const overlay: Partial<ParamDescriptor> = key === 'reasoning_effort'
                ? { canSend: m.reasoning_effort === true }
                : {};
            supportedParams[key] = { ...desc, ...overlay };
        }

        const capabilities: ModelCapabilities = {
            reasoning,
            toolCall: true,
            temperature: true,
            structuredOutput: false,
            attachment: false,
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportedParams,
        };

        const pricing = toCrofPricing(m.pricing);

        return {
            id: m.id,
            label: m.name ?? m.id,
            contextWindow: m.context_length ?? m.context_window ?? 0,
            capabilities,
            ...(pricing != null ? { pricing } : {}),
        };
    });
}

function toCrofPricing(p: CrofModel['pricing']): ModelPricing | undefined {
    if (!p) return undefined;
    const input = typeof p.prompt === 'string' ? parseFloat(p.prompt) : p.prompt;
    const output = typeof p.completion === 'string' ? parseFloat(p.completion) : p.completion;
    if (input == null || output == null || Number.isNaN(input) || Number.isNaN(output)) {
        return undefined;
    }
    const cached = typeof p.cache_prompt === 'string' ? parseFloat(p.cache_prompt) : p.cache_prompt;

    return {
        inputPerM: input,
        outputPerM: output,
        ...(cached != null && !Number.isNaN(cached) ? { cachedInputPerM: cached } : {}),
    };
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
        case 'open-code':
            return fetchOpenCode(getProviderApiKey(provider));
        case 'oxlo':
            return fetchOxlo(getProviderApiKey(provider));
        case 'crof':
            return fetchCrof();
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
    } catch (error) {
        console.log(error)
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

    let priceStr = modelInfo.pricing
        ? `$${modelInfo.pricing.inputPerM.toFixed(2)}/$${modelInfo.pricing.outputPerM.toFixed(2)} in/out` +
        (modelInfo.pricing.cachedInputPerM != null
            ? `  cached $${modelInfo.pricing.cachedInputPerM.toFixed(2)}`
            : '')
        : '? pricing';

    if (modelInfo.pricing?.reasoningPerM != null) {
        priceStr += `  reason $${modelInfo.pricing.reasoningPerM.toFixed(2)}`;
    }

    const badges: string[] = [];
    const c = modelInfo.capabilities;

    if (c) {
        if (c.reasoning) badges.push('think');
        if (c.toolCall) badges.push('tools');
        if (c.attachment) badges.push('attach');
        if (!c.temperature) badges.push('fixed-temp');
        if (c.structuredOutput) badges.push('json');
    }

    const badgeStr = badges.length > 0 ? ` [${badges.join(',')}]` : '';
    const label = modelInfo.label.padEnd(48);

    return `${label}  ${ctxStr}  ${priceStr}${badgeStr}`;
}
