/**
 * Shared agent provider + model picker.
 *
 * Used for the orchestrator AND for any sub-agent (executor / investigator).
 * The same UI code path is reused for every role so the user always sees the
 * same flow: pick BYOK or Copilot → (BYOK only) pick model provider → pick
 * model → (Copilot only) pick reasoning effort.
 *
 * The returned `client` is fully constructed; for Copilot it has been started
 * and auth-checked. The caller MUST keep a reference and call `forceStop` on
 * shutdown / error.
 */

import * as ui from '@/UI/generalUI';
import {
    SUPPORTED_PROVIDERS,
    type SupportedProvider,
    getProviderApiKey,
    getProviderBaseURL,
} from '@/AI/shared/data/providers';
import {
    type ModelInfo as ByokModelInfo,
    type ModelCapabilities,
    type ParamDescriptor,
    formatModelInfoForPicker,
    getModelCatalog,
} from '@/AI/shared/data/modelCatalog';
import {
    getModelsDevCatalog,
    lookupModelCapabilities,
    formatCapabilitiesSummary,
    type ModelsDevModelInfo,
} from '@/AI/shared/data/modelsDevCatalog';
import { OpenAICompatibleClient } from '@/AI/AIAgent/providers/byok/byokClient';
import { CopilotClientWrapper } from '@/AI/AIAgent/providers/copilot/copilotClient';
import { getGithubToken } from '@/AI/AIAgent/shared/utils/agentSettings';
import { type ModelInfo as CopilotModelInfo } from '@github/copilot-sdk';
import type { AgentClient, ReasoningEffort } from '@/AI/AIAgent/shared/types/agentTypes';
const PROVIDER_KIND_BYOK = 'BYOK (OpenAI-compatible)';
const PROVIDER_KIND_COPILOT = 'GitHub Copilot';

export type AgentProviderKind = 'byok' | 'copilot';
export type AgentRole = 'orchestrator' | 'executor' | 'investigator';

export interface AgentRuntimePick {
    kind: AgentProviderKind;
    client: AgentClient;
    model: string;
    contextWindow?: number;
    /** Dynamic capabilities fetched from models.dev for the selected model. */
    capabilities?: ModelCapabilities;
    /** Reasoning effort for BYOK models that support it. */
    reasoningEffort?: 'low' | 'medium' | 'high';
    /** Temperature override for BYOK sessions. */
    temperature?: number;
    /**
     * Generic per-(provider, model) optional params resolved by the picker.
     * Threaded through to `AgentSessionOptions.dynamicParams` so the BYOK
     * session's `OPTIONAL_PARAMS` registry / dynamic spec generator can pick
     * them up without each new param needing a typed field on this pick.
     */
    dynamicParams?: Record<string, unknown>;
}

async function pickByokRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const provider = (await ui.searchSelectAndReturnFromArray({
        itemsArray: [...SUPPORTED_PROVIDERS],
        prompt: `Select a BYOK provider for the ${role}`,
    })) as SupportedProvider;

    const models = await getModelCatalog(provider);
    if (models.length === 0) {
        throw new Error(`No models returned for provider '${provider}'.`);
    }

    let devModels: Map<string, ModelsDevModelInfo> = new Map();
    try {
        // First try provider-specific catalog, then supplement with global lookup
        const catalog = await getModelsDevCatalog(provider);
        devModels = new Map(catalog.map((m) => [m.id, m]));

        // For models not found in the provider catalog, try a global search
        // (e.g. open-code models like "minimax-m2.7" exist under "opencode" in models.dev)
        for (const m of models) {
            if (!devModels.has(m.id)) {
                try {
                    const globalMatch = await lookupModelCapabilities(m.id);
                    if (globalMatch) {
                        devModels.set(m.id, globalMatch);
                    }
                } catch { /* non-fatal per-model */ }
            }
        }
    } catch { /* non-fatal — models.dev may be unreachable */ }

    const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
    const labelToModel = new Map<string, ByokModelInfo>();
    for (const m of sorted) {
        labelToModel.set(formatModelInfoForPicker(m), m);
    }

    // Build a details callback that shows capabilities from models.dev
    const detailsCallback = (item: string, _index: number): string => {
        const model = labelToModel.get(item);
        if (!model) return '';
        const devInfo = devModels.get(model.id);
        if (devInfo) {
            return formatCapabilitiesSummary(devInfo);
        }
        // Fallback: show basic info from our catalog
        const lines: string[] = [];
        lines.push(`{bold}{cyan-fg}${model.label}{/cyan-fg}{/bold}`);
        lines.push('');
        if (model.contextWindow > 0) {
            lines.push(`{bold}Context window:{/}  ${Math.round(model.contextWindow / 1000).toLocaleString()}k tokens`);
        }
        if (model.pricing) {
            lines.push(`{bold}Pricing:{/}  $${model.pricing.inputPerM.toFixed(2)}/$${model.pricing.outputPerM.toFixed(2)} per 1M tokens`);
            if (model.pricing.cachedInputPerM != null) {
                lines.push(`  cached $${model.pricing.cachedInputPerM.toFixed(2)}`);
            }
        }

        return lines.join('\n');
    };

    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray: [...labelToModel.keys()],
        prompt: `Select a ${role} ${provider} model`,
        details: detailsCallback,
        detailsUseTags: true,
    });
    const picked = labelToModel.get(selectedLabel);
    if (!picked) {
        throw new Error(`Model selection '${selectedLabel}' could not be resolved.`);
    }

    // Resolve capabilities for the selected model. Preference order:
    //   1. Provider-native capabilities from the live `/v1/models` response
    //      (e.g. crof reports `reasoning_effort: true` per model). This is
    //      most accurate for custom-named models models.dev doesn't track.
    //   2. models.dev lookup for the canonical id.
    //   3. undefined — the legacy fallback at the bottom of this fn runs.
    const capabilities: ModelCapabilities | undefined =
        picked.capabilities ?? devModels.get(picked.id)?.capabilities;
    // Optional settings driven by `ModelCapabilities.supportedParams` (Phase
    // 3). The picker iterates the descriptor map and dispatches the right UI
    // for each param `type`. Values are stored both in `dynamicParams` and,
    // for legacy fields the rest of the codebase still reads directly
    // (`reasoningEffort` / `temperature`), in dedicated typed slots.
    let reasoningEffort: 'low' | 'medium' | 'high' | undefined;
    let temperature: number | undefined;
    const dynamicParams: Record<string, unknown> = {};

    const supportedParams = capabilities?.supportedParams;
    // Provider allowlist: only DeepInfra and crof reliably accept the OpenAI
    // enum form (`reasoning_effort: 'low'|'medium'|'high'`). Every other BYOK
    // proxy gets the boolean form (`reasoning_effort: true`) which they either
    // accept directly or translate into the upstream vendor's thinking control.
    // The picker UX follows: literal mode shows enum, boolean mode shows yes/no.
    const literalReasoningEffortProviders: ReadonlySet<string> = new Set(['deepinfra', 'copf']);
    const reasoningEffortMode: 'literal' | 'boolean' =
        literalReasoningEffortProviders.has(provider) ? 'literal' : 'boolean';
    const effectiveSupportedParams: Record<string, ParamDescriptor> | undefined = supportedParams
        ? Object.fromEntries(
            Object.entries(supportedParams).map(([key, desc]) => {
                if (key !== 'reasoning_effort') return [key, desc];

                return [key, { ...desc, sendAs: desc.sendAs ?? reasoningEffortMode }];
            }),
        )
        : undefined;

    if (effectiveSupportedParams && Object.keys(effectiveSupportedParams).length > 0) {
        for (const [key, desc] of Object.entries(effectiveSupportedParams)) {
            if (desc.canSend === false) continue;
            const value = await renderDynamicParamPicker(key, desc);
            if (value === undefined) continue;
            dynamicParams[key] = value;
            if (key === 'reasoning_effort' && typeof value === 'string') {
                reasoningEffort = value as 'low' | 'medium' | 'high';
            } else if (key === 'temperature') {
                temperature = value as number;
            }
        }
    } else {
        // Legacy fallback when models.dev capabilities (and thus
        // `supportedParams`) are unavailable. Mirrors values into
        // `dynamicParams` for parity with the descriptor-driven path.
        if (capabilities?.reasoning) {
            if (reasoningEffortMode === 'literal') {
                reasoningEffort = await pickByokReasoningEffort();
                if (reasoningEffort != null) {
                    dynamicParams['reasoning_effort'] = reasoningEffort;
                }
            } else {
                const enable = await ui.searchSelectAndReturnFromArray({
                    itemsArray: ['default', 'enable'],
                    prompt: 'Reasoning effort: enable thinking? (Esc / default = off)',
                }).catch(() => undefined);
                if (enable === 'enable') {
                    dynamicParams['reasoning_effort'] = true;
                }
            }
        }
        if (capabilities?.temperature !== false) {
            temperature = await pickByokTemperature();
            if (temperature != null) {
                dynamicParams['temperature'] = temperature;
            }
        }
    }

    const client = new OpenAICompatibleClient({
        baseURL: getProviderBaseURL(provider),
        apiKey: getProviderApiKey(provider),
        provider,
    });

    return {
        kind: 'byok',
        client,
        model: picked.id,
        ...(picked.contextWindow > 0 ? { contextWindow: picked.contextWindow } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(Object.keys(dynamicParams).length > 0 ? { dynamicParams } : {}),
    };
}

/**
 * Generic descriptor-driven picker used by `pickByokRuntime`. Dispatches the
 * right UI control based on `desc.type` and returns either a typed value or
 * `undefined` (Esc / skip / 'default'). Values are returned in their native
 * shape so they can be passed straight into the OpenAI Chat Completions
 * request body.
 */
async function renderDynamicParamPicker(
    key: string,
    desc: ParamDescriptor,
): Promise<unknown | undefined> {
    const labelWithDefault = desc.defaultValue != null
        ? `${desc.label} (default: ${String(desc.defaultValue)})`
        : desc.label;
    const prompt = `Select ${labelWithDefault} — Esc for default`;

    if (key === 'reasoning_effort' && desc.sendAs !== 'literal') {
        // Boolean wire shape — most BYOK proxies (opencode, openrouter, oxlo, …)
        // accept `reasoning_effort: true` and translate to the upstream
        // vendor's thinking control. Don't mislead the user with low/med/high
        // since the value is coerced to true at request build time anyway.
        const selected = await ui.searchSelectAndReturnFromArray({
            itemsArray: ['default', 'enable'],
            prompt: `${desc.label}: enable thinking? (Esc / default = off)`,
        }).catch(() => undefined);
        if (!selected || selected === 'default') return undefined;

        return true;
    }

    if (desc.type === 'enum') {
        const items = [...(desc.enumValues ?? [])];
        if (items.length === 0) return undefined;
        const selected = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt,
        }).catch(() => undefined);

        return selected ?? undefined;
    }

    if (desc.type === 'number') {
        const items = ['default', ...buildNumberSteps(desc)];
        const selected = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt,
        }).catch(() => undefined);
        if (!selected || selected === 'default') return undefined;
        const parsed = parseFloat(selected);

        return Number.isFinite(parsed) ? parsed : undefined;
    }

    if (desc.type === 'boolean') {
        const selected = await ui.searchSelectAndReturnFromArray({
            itemsArray: ['default', 'true', 'false'],
            prompt,
        }).catch(() => undefined);
        if (!selected || selected === 'default') return undefined;

        return selected === 'true';
    }

    // type === 'string' or future extension — not currently used by any
    // descriptor, but keep a safe fallback so adding one later doesn't crash.
    void key;

    return undefined;
}

/**
 * Build a discrete value list for a numeric descriptor (default 21 steps
 * across the [min, max] range, snapped to `step` precision).
 */
function buildNumberSteps(desc: ParamDescriptor): string[] {
    if (desc.min == null || desc.max == null) return [];
    const step = desc.step ?? (desc.max - desc.min) / 20;
    if (step <= 0) return [];
    const out: string[] = [];
    const decimals = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
    for (let v = desc.min; v <= desc.max + 1e-9; v += step) {
        out.push(v.toFixed(decimals));
    }

    return out;
}

async function pickByokReasoningEffort(): Promise<'low' | 'medium' | 'high' | undefined> {
    const itemsArray = ['low', 'medium', 'high'];
    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: 'Select reasoning effort level (or Esc to skip)',
    }).catch(() => undefined);

    if (!selected) return undefined;

    return selected as 'low' | 'medium' | 'high';
}

async function pickByokTemperature(): Promise<number | undefined> {
    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray: ['default', '0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0', '1.5', '2.0'],
        prompt: 'Select temperature (or Esc for default)',
    }).catch(() => undefined);

    if (!selected || selected === 'default') return undefined;

    return parseFloat(selected);
}

async function pickCopilotReasoningEffort(model: CopilotModelInfo): Promise<ReasoningEffort | undefined> {
    const supported = model.supportedReasoningEfforts;
    if (!supported?.length) {
        return undefined;
    }
    const defaultEffort = model.defaultReasoningEffort;
    const itemsArray = supported.map((effort) =>
        defaultEffort === effort ? `${effort} (default)` : effort
    );
    const selected = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: 'Select reasoning effort level',
    });

    return selected.replace(' (default)', '') as ReasoningEffort;
}

async function pickCopilotRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const githubToken = getGithubToken();
    const client = new CopilotClientWrapper({
        ...(githubToken ? { githubToken } : {}),
        useLoggedInUser: !githubToken,
    });

    await client.start();
    const authStatus = await client.getAuthStatus();
    if (!authStatus.isAuthenticated && !githubToken) {
        await client.forceStop();
        throw new Error(authStatus.statusMessage ?? 'GitHub Copilot SDK authentication is not configured.');
    }

    const models = [...(await client.listModels())].sort((a, b) =>
        a.name.localeCompare(b.name)
    );
    const labelToModel = new Map<string, CopilotModelInfo>();
    const itemsArray = models.map((m) => {
        const disabled = m.policy?.state === 'disabled';
        const billing = m.billing?.multiplier ? ` [x${m.billing.multiplier}]` : '';
        const label = disabled
            ? `[DISABLED] ${m.name} (${m.id})${billing}`
            : `${m.name} (${m.id})${billing}`;
        labelToModel.set(label, m);

        return label;
    });

    const selectedLabel = await ui.searchSelectAndReturnFromArray({
        itemsArray,
        prompt: `Select a ${role} Copilot model`,
    });
    const selectedModel = labelToModel.get(selectedLabel);
    if (!selectedModel) {
        await client.forceStop();
        throw new Error('No Copilot model selected.');
    }

    const reasoningEffort = await pickCopilotReasoningEffort(selectedModel);
    client.setReasoningEffort(reasoningEffort);

    return {
        kind: 'copilot',
        client,
        model: selectedModel.id,
    };
}

export async function pickAgentRuntime(role: AgentRole): Promise<AgentRuntimePick> {
    const kind = await ui.searchSelectAndReturnFromArray({
        itemsArray: [PROVIDER_KIND_BYOK, PROVIDER_KIND_COPILOT],
        prompt: `Provider for the ${role}`,
    });

    if (kind === PROVIDER_KIND_COPILOT) {
        return pickCopilotRuntime(role);
    }

    return pickByokRuntime(role);
}
