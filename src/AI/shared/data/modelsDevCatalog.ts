/**
 * Models.dev catalog — dynamic model capability metadata.
 *
 * Fetches https://models.dev/api.json and enriches our existing ModelInfo
 * with capability data (reasoning, tool_call, temperature, structured_output,
 * modalities, etc.). This data drives:
 *
 *   1. The model-details split-screen dashboard shown after model selection.
 *   2. The BYOK session's awareness of which reasoning field to watch
 *      (`reasoning_content` vs `reasoning_details` vs raw `reasoning`).
 *   3. Optional BYOK dynamic settings (reasoning effort, temperature, etc.)
 *      presented after the model is picked.
 *
 * Results are cached on disk under `~/.kra/model-catalog/modelsdev.json`
 * with a 24-hour TTL, identical to the per-provider cache strategy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { kraHome } from '@/filePaths';
import { type SupportedProvider } from '@/AI/shared/data/providers';
import {
    BUILTIN_PARAM_DESCRIPTORS,
    type ModelCapabilities,
    type ParamDescriptor,
    type ModelPricing,
} from '@/AI/shared/data/modelCatalog';

// ─── Public types ────────────────────────────────────────────────────────────

/** Raw model entry from models.dev/api.json */
export interface ModelsDevModel {
    id: string;
    name?: string;
    family?: string;
    attachment?: boolean;
    reasoning?: boolean;
    /** True or an object like { field: 'reasoning_content' } */
    interleaved?: boolean | { field: string };
    tool_call?: boolean;
    temperature?: boolean;
    structured_output?: boolean;
    modalities?: {
        input?: string[];
        output?: string[];
    };
    open_weights?: boolean;
    knowledge?: string;
    release_date?: string;
    last_updated?: string;
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
        input_audio?: number;
        output_audio?: number;
        reasoning?: number;
        context_over_200k?: number;
    };
    limit?: {
        context?: number;
        input?: number;
        output?: number;
    };
}

/** Raw provider entry from models.dev/api.json */
export interface ModelsDevProvider {
    id: string;
    name?: string;
    api?: string;
    env?: string[];
    npm?: string;
    doc?: string;
    models: Record<string, ModelsDevModel>;
}

export interface ModelsDevModelInfo {
    /** The model ID within the provider (e.g. 'deepseek-reasoner'). */
    id: string;
    /** Human-friendly display name. */
    name: string;
    /** Provider key in models.dev (e.g. 'deepseek'). */
    provider: string;
    /** Provider display name (e.g. 'DeepSeek'). */
    providerName: string;
    capabilities: ModelCapabilities;
    pricing?: ModelPricing;
    contextWindow: number;
    maxOutputTokens?: number;
}

// ─── Provider mapping ───────────────────────────────────────────────────────

/**
 * Maps our internal SupportedProvider identifiers to the keys used by
 * models.dev/api.json. Not all our providers exist there; the ones that
 * don't simply return an empty array from the catalog.
 */
const PROVIDER_TO_MODELSDEV: Record<string, string> = {
    'deep-seek': 'deepseek',
    'open-ai': 'openai',
    'open-router': 'openrouter',
    'gemini': 'google',
    'mistral': 'mistral',
    'deep-infra': 'deepinfra',
    'open-code': 'opencode',
    'oxlo': 'oxlo',
};

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
    fetchedAt: number;
    providers: Record<string, ModelsDevProvider>;
}

function cachePath(): string {
    return path.join(kraHome(), 'model-catalog', 'modelsdev.json');
}

function readCache(): CacheEntry | undefined {
    try {
        const raw = fs.readFileSync(cachePath(), 'utf8');
        const parsed = JSON.parse(raw) as CacheEntry;
        if (typeof parsed.fetchedAt !== 'number' || typeof parsed.providers !== 'object') {
            return undefined;
        }

        return parsed;
    } catch {
        return undefined;
    }
}

function writeCache(providers: Record<string, ModelsDevProvider>): void {
    try {
        const dir = path.dirname(cachePath());
        fs.mkdirSync(dir, { recursive: true });
        const entry: CacheEntry = { fetchedAt: Date.now(), providers };
        fs.writeFileSync(cachePath(), JSON.stringify(entry, null, 2), 'utf8');
    } catch {
        // best-effort; not fatal
    }
}

// ─── Live fetch ──────────────────────────────────────────────────────────────

const MODELSDEV_URL = 'https://models.dev/api.json';

async function fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
    const res = await fetch(MODELSDEV_URL);
    if (!res.ok) {
        throw new Error(`models.dev/api.json returned ${res.status}`);
    }
    const json = await res.json() as Record<string, ModelsDevProvider>;

    return json;
}

// ─── Internal cache ──────────────────────────────────────────────────────────

let cachedProviders: Record<string, ModelsDevProvider> | undefined;

async function getProviders(opts?: { forceRefresh?: boolean }): Promise<Record<string, ModelsDevProvider>> {
    if (cachedProviders && !opts?.forceRefresh) {
        return cachedProviders;
    }

    // Try disk cache first
    if (!opts?.forceRefresh) {
        const disk = readCache();
        if (disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS) {
            cachedProviders = disk.providers;

            return cachedProviders;
        }
    }

    try {
        const providers = await fetchModelsDev();
        writeCache(providers);
        cachedProviders = providers;

        return providers;
    } catch {
        // Fall back to stale cache or empty
        const stale = readCache();
        if (stale) {
            cachedProviders = stale.providers;

            return cachedProviders;
        }

        return {};
    }
}

// ─── Transform helpers ────────────────────────────────────────────────────────

function extractReasoningField(model: ModelsDevModel): 'reasoning_content' | 'reasoning_details' | undefined {
    const interleaved = model.interleaved;
    if (typeof interleaved === 'object' && interleaved !== null) {
        const field = (interleaved as { field: string }).field;
        if (field === 'reasoning_content' || field === 'reasoning_details') {
            return field;
        }

        // Unknown interleaved field — fall back to reasoning_content
        // (the most common delta field across OpenAI-compatible providers).
        return 'reasoning_content';
    }
    // If reasoning is true but no interleaved object, default to reasoning_content
    // (most OpenAI-compatible providers use reasoning_content)
    if (model.reasoning) {
        return 'reasoning_content';
    }

    return undefined;
}

function buildSupportedParams(model: ModelsDevModel): Record<string, ParamDescriptor> {
    // Overlay models.dev boolean capability flags onto the source-of-truth
    // descriptor table to flip `canSend` per model. Keys not represented in
    // models.dev are passed through unchanged (canSend defaults to true).
    const overlay: Record<string, Partial<ParamDescriptor>> = {
        temperature: { canSend: model.temperature !== false },
        reasoning_effort: { canSend: model.reasoning === true },
    };

    const out: Record<string, ParamDescriptor> = {};
    for (const [key, desc] of Object.entries(BUILTIN_PARAM_DESCRIPTORS)) {
        out[key] = { ...desc, ...(overlay[key] ?? {}) };
    }

    return out;
}

function toModelCapabilities(model: ModelsDevModel): ModelCapabilities {
    const reasoningField = extractReasoningField(model);

    return {
        reasoning: model.reasoning ?? false,
        ...(reasoningField != null ? { reasoningField } : {}),
        toolCall: model.tool_call ?? false,
        temperature: model.temperature ?? true,
        structuredOutput: model.structured_output ?? false,
        attachment: model.attachment ?? false,
        inputModalities: model.modalities?.input ?? ['text'],
        outputModalities: model.modalities?.output ?? ['text'],
        ...(model.cost?.reasoning != null ? { reasoningCostPerM: model.cost.reasoning } : {}),
        ...(model.knowledge != null ? { knowledge: model.knowledge } : {}),
        ...(model.release_date != null ? { releaseDate: model.release_date } : {}),
        ...(model.family != null ? { family: model.family } : {}),
        ...(model.open_weights != null ? { openWeights: model.open_weights } : {}),
        supportedParams: buildSupportedParams(model),
    };
}

function toPricing(cost: ModelsDevModel['cost']): ModelPricing | undefined {
    if (cost?.input == null || cost.output == null) return undefined;

    return {
        inputPerM: cost.input,
        outputPerM: cost.output,
        ...(cost.cache_read != null ? { cachedInputPerM: cost.cache_read } : {}),
        ...(cost.reasoning != null ? { reasoningPerM: cost.reasoning } : {}),
    };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch model metadata from models.dev for a specific provider.
 * Returns an enriched list matching models by ID and augmenting them
 * with capability data.
 */
export async function getModelsDevCatalog(
    provider: SupportedProvider,
    opts?: { forceRefresh?: boolean }
): Promise<ModelsDevModelInfo[]> {
    const providers = await getProviders(opts);
    const modelsDevKey = PROVIDER_TO_MODELSDEV[provider];
    if (!modelsDevKey) return [];
    const providerData = providers[modelsDevKey];
    if (!providerData) return [];

    return Object.values(providerData.models).map((model): ModelsDevModelInfo => {
        const pricing = toPricing(model.cost);
        const maxOutputTokens = model.limit?.output;

        return {
            id: model.id,
            name: model.name ?? model.id,
            provider: modelsDevKey,
            providerName: providerData.name ?? modelsDevKey,
            capabilities: toModelCapabilities(model),
            ...(pricing != null ? { pricing } : {}),
            contextWindow: model.limit?.context ?? 0,
            ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
        };
    });
}

/**
 * Look up a single model's capabilities from models.dev.
 * Searches across all providers for a match.
 */
export async function lookupModelCapabilities(
    modelId: string,
    opts?: { forceRefresh?: boolean }
): Promise<ModelsDevModelInfo | undefined> {
    const providers = await getProviders(opts);

    for (const [providerKey, providerData] of Object.entries(providers)) {
        const model = providerData.models[modelId];
        if (model) {
            const pricing = toPricing(model.cost);
            const maxOutputTokens = model.limit?.output;

            return {
                id: model.id,
                name: model.name ?? model.id,
                provider: providerKey,
                providerName: providerData.name ?? providerKey,
                capabilities: toModelCapabilities(model),
                ...(pricing != null ? { pricing } : {}),
                contextWindow: model.limit?.context ?? 0,
                ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
            };
        }
    }

    return undefined;
}

/**
 * Look up capabilities for a model within a specific provider.
 * Uses the provider mapping so it correctly handles our internal names
 * (e.g. 'deep-seek' → models.dev's 'deepseek').
 */
export async function lookupModelCapabilitiesForProvider(
    modelId: string,
    provider: SupportedProvider,
    opts?: { forceRefresh?: boolean }
): Promise<ModelsDevModelInfo | undefined> {
    const catalog = await getModelsDevCatalog(provider, opts);

    return catalog.find((m) => m.id === modelId);
}

/**
 * Build a summary string describing a model's capabilities.
 * Used in the model-details dashboard.
 */
export function formatCapabilitiesSummary(info: ModelsDevModelInfo): string {
    const lines: string[] = [];
    const c = info.capabilities;

    lines.push(`{bold}{cyan-fg}${info.name}{/cyan-fg}{/bold}`);
    lines.push(`{gray-fg}Provider: ${info.providerName}  |  Family: ${c.family ?? '—'}{/}`);
    lines.push('');

    // Context & output limits
    const ctxStr = info.contextWindow > 0
        ? `${Math.round(info.contextWindow / 1000).toLocaleString()}k`
        : '?';
    const outStr = info.maxOutputTokens
        ? `${Math.round(info.maxOutputTokens / 1000).toLocaleString()}k`
        : '?';
    lines.push(`{bold}Context window:{/}  ${ctxStr} tokens`);
    lines.push(`{bold}Max output:{/}       ${outStr} tokens`);

    // Pricing
    if (info.pricing) {
        const inP = `$${info.pricing.inputPerM.toFixed(2)}`;
        const outP = `$${info.pricing.outputPerM.toFixed(2)}`;
        let priceLine = `{bold}Pricing:{/}          ${inP} / ${outP} in/out per 1M tokens`;
        if (info.pricing.cachedInputPerM != null) {
            priceLine += `  cached $${info.pricing.cachedInputPerM.toFixed(2)}`;
        }
        if (info.pricing.reasoningPerM != null) {
            priceLine += `  reasoning $${info.pricing.reasoningPerM.toFixed(2)}`;
        }
        lines.push(priceLine);
    }

    lines.push('');
    lines.push('{bold}Capabilities:{/}');

    // Reasoning
    if (c.reasoning) {
        const fieldInfo = c.reasoningField ? ` (delta: ${c.reasoningField})` : '';
        lines.push(`  ✓ Reasoning${fieldInfo}`);
    } else {
        lines.push(`  ✗ Reasoning`);
    }

    // Tool calling
    lines.push(c.toolCall ? '  ✓ Tool calling' : '  ✗ Tool calling');

    // Temperature
    lines.push(c.temperature ? '  ✓ Temperature' : '  ✗ Temperature (fixed)');

    // Structured output
    lines.push(c.structuredOutput ? '  ✓ Structured output' : '  ✗ Structured output');

    // Attachments
    lines.push(c.attachment ? '  ✓ File attachments' : '  ✗ File attachments');

    // Modalities
    lines.push(`  Input:  ${c.inputModalities.join(', ')}`);
    lines.push(`  Output: ${c.outputModalities.join(', ')}`);

    // Open weights
    if (c.openWeights != null) {
        lines.push(c.openWeights ? '  ✓ Open weights' : '  ✗ Open weights');
    }

    // Knowledge cutoff
    if (c.knowledge) {
        lines.push(`{bold}Knowledge:{/}        ${c.knowledge}`);
    }

    // Release date
    if (c.releaseDate) {
        lines.push(`{bold}Released:{/}         ${c.releaseDate}`);
    }

    return lines.join('\n');
}
