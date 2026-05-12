/**
 * Persisted (provider, model) overrides for BYOK quirks we discover at runtime.
 *
 * Stored under `${KRA_HOME}/byok-overrides/<provider>.json`. Today we cache:
 *  - `strippedParams`: OpenAI param keys the provider rejected with HTTP 400,
 *    seeded into the next session so we skip the round-trip.
 *  - `streamingMode`: `'non-streaming'` when we've detected the provider
 *    silently buffers its upstream response into one SSE frame.
 *  - `inlineReasoningTags`: `true` when the model writes its chain-of-thought
 *    inline as `<think>…</think>` inside `delta.content` instead of using the
 *    structured `reasoning_content` / `reasoning_details` fields.
 *
 * Reads are sync (fast, called once in the session constructor); writes are
 * async, debounced via a per-file promise chain, and best-effort (failures
 * are swallowed because losing one cache update is non-fatal).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import { kraHome } from '@/filePaths';

export interface ModelOverrides {
    strippedParams?: string[];
    streamingMode?: 'streaming' | 'non-streaming';
    inlineReasoningTags?: boolean;
    updatedAt?: string;
}

function overridesDir(): string {
    return path.join(kraHome(), 'byok-overrides');
}

function slug(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function overridesPath(provider: string): string {
    return path.join(overridesDir(), `${slug(provider)}.json`);
}

export function loadOverridesSync(provider: string | undefined): Record<string, ModelOverrides> {
    if (!provider) return {};
    try {
        const raw = fs.readFileSync(overridesPath(provider), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, ModelOverrides>;
        }
    } catch {
        // No cache yet, malformed JSON, or unreadable file — treat as empty.
    }

    return {};
}

export function getModelOverride(provider: string | undefined, model: string): ModelOverrides {
    const map = loadOverridesSync(provider);

    return map[model] ?? {};
}

const writeQueue = new Map<string, Promise<void>>();

export async function recordOverride(
    provider: string | undefined,
    model: string,
    patch: Partial<ModelOverrides>,
): Promise<void> {
    if (!provider) return;

    const file = overridesPath(provider);
    const prior = writeQueue.get(file) ?? Promise.resolve();
    const next = prior.then(async () => {
        const current = loadOverridesSync(provider);
        const existing = current[model] ?? {};
        const merged: ModelOverrides = {
            ...existing,
            ...patch,
            updatedAt: new Date().toISOString(),
        };

        if (patch.strippedParams) {
            const union = new Set<string>([
                ...(existing.strippedParams ?? []),
                ...patch.strippedParams,
            ]);
            merged.strippedParams = [...union];
        }

        current[model] = merged;
        await fsp.mkdir(overridesDir(), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(current, null, 2), 'utf8');
    }).catch(() => {
        // Non-critical — losing one cache update doesn't break the session.
    });

    writeQueue.set(file, next);

    return next;
}
