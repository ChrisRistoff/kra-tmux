/**
 * `kra ai index` — full reindex of the workspace into the kra-memory
 * code_chunks table. Streams progress to the terminal and updates the
 * central repo registry so future agent launches see the catch-up baseline.
 */

import { reindexAll, workspaceRoot } from '@/AI/AIAgent/shared/memory/indexer';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import { countCodeChunks } from '@/AI/AIAgent/shared/memory/db';
import { getRepoIdentity, upsertRegistryEntry } from '@/AI/AIAgent/shared/memory/registry';
import { execCommand } from '@/utils/bashHelper';

async function safeHeadCommit(repoRoot: string): Promise<string> {
    try {
        const r = await execCommand(`git -C '${repoRoot.replace(/'/g, `'\\''`)}' rev-parse HEAD`);
        return r.stdout.trim();
    } catch {
        return '';
    }
}

export async function indexCodebase(): Promise<void> {
    const settings = await loadMemorySettings();

    if (!settings.enabled) {
        console.log('kra-memory is disabled in settings.toml ([ai.agent.memory] enabled = false). Aborting.');

        return;
    }

    console.log('kra-memory: starting full code index…');

    let lastPath = '';
    const result = await reindexAll({
        onProgress: (p) => {
            if (p.phase === 'embedding' && p.currentPath && p.currentPath !== lastPath) {
                lastPath = p.currentPath;
                const pct = p.filesTotal > 0 ? Math.floor((p.filesDone / p.filesTotal) * 100) : 0;

                process.stdout.write(`  [${pct.toString().padStart(3)}%] ${p.filesDone}/${p.filesTotal}  ${p.currentPath}\n`);
            }

            if (p.phase === 'scanning') {
                console.log(`kra-memory: scanning workspace, ${p.filesTotal} indexable files found`);
            }
        },
    });

    const root = workspaceRoot();
    const identity = await getRepoIdentity(root);
    const totalChunks = await countCodeChunks().catch(() => result.chunksWritten);
    await upsertRegistryEntry(identity.id, {
        alias: identity.alias,
        rootPath: identity.rootPath,
        lastIndexedCommit: await safeHeadCommit(identity.rootPath),
        lastIndexedAt: Date.now(),
        chunksCount: totalChunks,
    });

    console.log('');
    console.log(`kra-memory: indexed ${result.filesScanned} files in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`            ${result.chunksWritten} chunks written, ${result.chunksSkipped} unchanged, ${result.chunksDeleted} stale removed`);
    console.log(`            registry updated for '${identity.alias}' (${totalChunks} total chunks)`);
}
