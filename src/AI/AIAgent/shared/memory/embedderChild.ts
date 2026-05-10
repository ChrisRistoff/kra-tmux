/**
 * fastembed child process.
 *
 * Owns the FlagEmbedding model + ONNX runtime in a SEPARATE OS process
 * (spawned via `child_process.fork`) so we can `kill()` it on idle to
 * unconditionally return the ~450 MB native arena to the kernel.
 * worker_threads are insufficient on macOS — they share the parent's
 * malloc arena, so terminate() frees but does not unmap the pages.
 *
 * Protocol (parent <-> child):
 *   parent -> child: { type: 'embed', id, texts }
 *   child -> parent: { type: 'result', id, vectors } | { type: 'error', id, message }
 *   child -> parent (one-shot at startup): { type: 'ready' }
 */

import fs from 'fs';
import type { FlagEmbedding as FlagEmbeddingType } from 'fastembed';

const cacheDir = process.env['KRA_EMBEDDER_CACHE_DIR'] ?? '';

if (!cacheDir) {
    process.stderr.write('embedderChild: missing KRA_EMBEDDER_CACHE_DIR env var\n');
    process.exit(2);
}

if (typeof process.send !== 'function') {
    process.stderr.write('embedderChild: not running as a forked child (process.send unavailable)\n');
    process.exit(2);
}

const send = process.send.bind(process);

let model: FlagEmbeddingType | null = null;
let pending: Promise<FlagEmbeddingType> | null = null;

async function loadModel(): Promise<FlagEmbeddingType> {
    if (model) return model;
    if (pending) return pending;

    pending = (async () => {
        fs.mkdirSync(cacheDir, { recursive: true });
        const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
        const m = await FlagEmbedding.init({
            model: EmbeddingModel.BGESmallENV15,
            cacheDir,
        });
        model = m;
        pending = null;

        return m;
    })().catch((err) => {
        pending = null;
        throw err;
    });

    return pending;
}

type EmbedRequest = { type: 'embed'; id: number; texts: string[] };

let queue: Promise<unknown> = Promise.resolve();

function handleEmbed(req: EmbedRequest): void {
    queue = queue
        .then(async () => {
            const m = await loadModel();
            const out: number[][] = [];

            for await (const batch of m.embed(req.texts, Math.min(32, req.texts.length))) {
                for (const vec of batch) {
                    out.push(Array.from(vec));
                }
            }

            if (out.length !== req.texts.length) {
                throw new Error(`embedderChild: expected ${req.texts.length} vectors, got ${out.length}`);
            }
            send({ type: 'result', id: req.id, vectors: out });
        })
        .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            send({ type: 'error', id: req.id, message });
        });
}

process.on('message', (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string };
    if (m.type === 'embed') {
        handleEmbed(msg as EmbedRequest);
    }
});

// If the parent dies and the IPC channel closes, exit cleanly so we
// don't linger as an orphan holding 450 MB.
process.on('disconnect', () => {
    process.exit(0);
});

send({ type: 'ready' });
