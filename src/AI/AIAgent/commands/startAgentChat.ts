import * as ui from '@/UI/generalUI';
import { startCopilotFlow } from '@/AI/AIAgent/providers/copilot';
import { startByokFlow } from '@/AI/AIAgent/providers/byok';
import { reindexAll } from '@/AI/AIAgent/shared/memory/indexer';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import { startWatcher, type WatcherHandle } from '@/AI/AIAgent/shared/memory/watcher';

export async function startAgentChat(): Promise<void> {
    const provider = await ui.searchSelectAndReturnFromArray({
        itemsArray: ['copilot', 'byok'],
        prompt: 'Select agent provider',
    });

    const memorySettings = await loadMemorySettings();
    let watcher: WatcherHandle | null = null;

    if (memorySettings.enabled) {
        if (memorySettings.indexCodeOnStart) {
            try {
                console.log('kra-memory: running startup code reindex…');
                const result = await reindexAll();

                console.log(`kra-memory: indexed ${result.filesScanned} files (${result.chunksWritten} new, ${result.chunksSkipped} unchanged) in ${(result.elapsedMs / 1000).toFixed(1)}s`);
            } catch (err) {
                console.warn(`kra-memory: startup index failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        if (memorySettings.indexCodeOnSave) {
            try {
                watcher = await startWatcher();
            } catch (err) {
                console.warn(`kra-memory: watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    try {
        if (provider === 'byok') {
            await startByokFlow();

            return;
        }

        await startCopilotFlow();
    } finally {
        if (watcher) await watcher.close();
    }
}
