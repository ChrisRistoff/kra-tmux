/**
 * LSP server registry.
 *
 * Reads `[lsp.<id>]` blocks from settings, maps file extensions to server
 * specs, resolves a per-file workspace root via root-marker walk, and caches
 * one running `LspClient` per (serverId, workspaceRoot) pair.
 *
 * Clients are spawned lazily on the first `getClientFor()` call for a given
 * pair, kept alive for the lifetime of the host process, and shut down via
 * the registered exit hooks.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { loadSettings } from '../../../utils/common';
import type { LspServerSettings } from '../../../types/settingsTypes';
import { LspClient, LspServerSpec } from './lspClient';

const DEFAULT_ROOT_MARKERS = ['.git'];
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type RegistryEntry = {
    id: string;
    settings: LspServerSettings;
}

let registryPromise: Promise<LspRegistry> | undefined;

export async function getLspRegistry(): Promise<LspRegistry> {
    if (!registryPromise) {
        registryPromise = LspRegistry.load();
    }

    return registryPromise;
}

export class LspRegistry {
    private readonly extToEntry = new Map<string, RegistryEntry>();
    private readonly clients = new Map<string, LspClient>();
    private shuttingDown = false;

    static async load(): Promise<LspRegistry> {
        const settings = await loadSettings();
        const reg = new LspRegistry();
        const lsp = settings.lsp ?? {};
        for (const [id, spec] of Object.entries(lsp)) {
            if (spec.active === false) continue;
            for (const ext of spec.extensions) {
                const norm = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
                reg.extToEntry.set(norm, { id, settings: spec });
            }
        }
        reg.installShutdownHooks();

        return reg;
    }

    private installShutdownHooks(): void {
        const handler = (): void => { void this.shutdownAll(); };
        process.once('exit', handler);
        process.once('SIGINT', () => { void this.shutdownAll().then(() => process.exit(130)); });
        process.once('SIGTERM', () => { void this.shutdownAll().then(() => process.exit(143)); });
    }

    hasServerFor(filePath: string): boolean {
        return this.extToEntry.has(path.extname(filePath).toLowerCase());
    }

    /**
     * Returns a started client for the given file, or undefined when no LSP
     * is configured for the file's extension. Spawns lazily; subsequent calls
     * for the same (server, root) reuse the same client.
     */
    async getClientFor(filePath: string): Promise<LspClient | undefined> {
        if (this.shuttingDown) return undefined;
        const abs = path.resolve(filePath);
        const ext = path.extname(abs).toLowerCase();
        const entry = this.extToEntry.get(ext);
        if (!entry) return undefined;

        const markers = entry.settings.rootMarkers && entry.settings.rootMarkers.length > 0
            ? entry.settings.rootMarkers
            : DEFAULT_ROOT_MARKERS;
        const root = await resolveWorkspaceRoot(abs, markers);
        const key = `${entry.id}\u0000${root}`;

        let client = this.clients.get(key);
        if (client && !client.isAlive()) {
            this.clients.delete(key);
            client = undefined;
        }
        if (!client) {
            const spec = toSpec(entry);
            client = new LspClient(spec, root);
            this.clients.set(key, client);
            try {
                await client.start();
            } catch (err) {
                this.clients.delete(key);
                throw err;
            }
        } else {
            await client.start();
        }

        return client;
    }

    listConfiguredExtensions(): string[] {
        return Array.from(this.extToEntry.keys()).sort();
    }

    listLiveClients(): LspClient[] {
        return Array.from(this.clients.values()).filter(c => c.isAlive());
    }

    async shutdownAll(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        const clients = Array.from(this.clients.values());
        this.clients.clear();
        await Promise.allSettled(clients.map(async c => c.shutdown()));
    }
}

function toSpec(entry: RegistryEntry): LspServerSpec {
    return {
        id: entry.id,
        cmd: entry.settings.cmd,
        args: entry.settings.args ?? [],
        env: entry.settings.env,
        initOptions: entry.settings.initOptions,
        spawnTimeoutMs: entry.settings.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
        requestTimeoutMs: entry.settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
}

async function resolveWorkspaceRoot(absFilePath: string, markers: string[]): Promise<string> {
    let dir = path.dirname(absFilePath);
    const root = path.parse(dir).root;
    while (true) {
        for (const marker of markers) {
            try {
                await fs.access(path.join(dir, marker));

                return dir;
            } catch {
                // not found here; keep walking
            }
        }
        if (dir === root) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return path.dirname(absFilePath);
}
