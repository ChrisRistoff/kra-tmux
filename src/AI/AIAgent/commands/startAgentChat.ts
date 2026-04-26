import * as ui from '@/UI/generalUI';
import { startCopilotFlow } from '@/AI/AIAgent/providers/copilot';
import { startByokFlow } from '@/AI/AIAgent/providers/byok';
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
        // The interactive Yes/No prompt + initial reindex is now handled inside
        // runStartupIndexingFlow (called from agentConversation). The legacy
        // unconditional `reindexAll()` was removed because it would silently
        // recreate the code_chunks table even after the user opted out.
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
