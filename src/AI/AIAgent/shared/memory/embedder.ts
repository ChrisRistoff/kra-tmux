/**
 * fastembed wrapper for the kra-memory layer.
 *
 * Uses BGESmallENV15 (384-dim, ~33MB quantized) for a balance of quality and
 * footprint. Model is loaded lazily on first call. The model cache lives in a
 * stable user-global directory so we don't pollute every working tree with a
 * local_cache/ folder.
 */

import fs from 'fs';
import path from 'path';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { kraHome } from '@/filePaths';

const MODEL = EmbeddingModel.BGESmallENV15;
export const VECTOR_DIM = 384;

let cachedModel: FlagEmbedding | null = null;
let pendingLoad: Promise<FlagEmbedding> | null = null;

// Serialize embed calls. fastembed/ONNX is not guaranteed to be reentrant
// from concurrent JS callers — multi-repo parallel indexing would otherwise
// dispatch overlapping embed batches into the same model instance.
let embedQueue: Promise<unknown> = Promise.resolve();

function defaultCacheDir(): string {
    const override = process.env['KRA_MEMORY_MODEL_CACHE'];

    if (override && override.length > 0) {
        return override;
    }

    return path.join(kraHome(), 'cache', 'fastembed');
}

async function loadModel(): Promise<FlagEmbedding> {
    if (cachedModel) {
        return cachedModel;
    }

    if (pendingLoad) {
        return pendingLoad;
    }

    const cacheDir = defaultCacheDir();
    fs.mkdirSync(cacheDir, { recursive: true });

    pendingLoad = FlagEmbedding.init({
        model: MODEL,
        cacheDir,
    }).then((model) => {
        cachedModel = model;
        pendingLoad = null;

        return model;
    }).catch((error) => {
        pendingLoad = null;
        throw error;
    });

    return pendingLoad;
}

/**
 * Embed a single string. Returns a plain `number[]` so it can be passed
 * directly to LanceDB without Arrow conversion gymnastics.
 */
export async function embedOne(text: string): Promise<number[]> {
    const results = await embedMany([text]);

    if (results.length === 0) {
        throw new Error('embedOne: fastembed returned no vectors');
    }

    return results[0];
}

/**
 * Embed a batch of strings. Order of returned vectors matches input order.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
        return [];
    }

    const next = embedQueue.then(async () => {
        const model = await loadModel();
        const out: number[][] = [];

        for await (const batch of model.embed(texts, Math.min(32, texts.length))) {
            for (const vec of batch) {
                out.push(Array.from(vec));
            }
        }

        if (out.length !== texts.length) {
            throw new Error(`embedMany: expected ${texts.length} vectors, got ${out.length}`);
        }

        return out;
    });
    embedQueue = next.catch(() => undefined);

    return next;
}
