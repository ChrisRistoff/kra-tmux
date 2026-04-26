/**
 * `kra ai index` — full reindex of the workspace into the kra-memory
 * code_chunks table. Streams progress to the terminal.
 */

import { reindexAll } from '@/AI/AIAgent/shared/memory/indexer';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';

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

    console.log('');
    console.log(`kra-memory: indexed ${result.filesScanned} files in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`            ${result.chunksWritten} chunks written, ${result.chunksSkipped} unchanged, ${result.chunksDeleted} stale removed`);
}
