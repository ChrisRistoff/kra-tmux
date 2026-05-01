/**
 * Top-level entry point for starting an AI agent chat session.
 *
 * Picker order (matches what the user sees on the screen):
 *   1. Orchestrator provider → (BYOK only) model provider → model
 *      → (Copilot only) reasoning effort
 *   2. For each enabled sub-agent (executor, investigator) the same flow
 *      runs again so each can independently pick BYOK or Copilot.
 *
 * Provider-specific concerns are kept tight:
 *   - BYOK orchestrators get the kra-bash + kra-web MCP servers attached.
 *   - Copilot has those tools natively and does not need them re-attached.
 */

import * as conversation from '@/AI/AIAgent/shared/main/agentConversation';
import { buildByokExtraMcpServers } from '@/AI/AIAgent/mcp/serverConfig';
import { loadMemorySettings } from '@/AI/AIAgent/shared/memory/settings';
import { startWatcher, type WatcherHandle } from '@/AI/AIAgent/shared/memory/watcher';
import { loadSubAgentSettings } from '@/AI/AIAgent/shared/subAgents/settings';
import { pickAgentRuntime } from '@/AI/AIAgent/commands/subAgentProviderPicker';
import type { AgentClient } from '@/AI/AIAgent/shared/types/agentTypes';
import type {
    ExecutorRuntime,
    InvestigatorRuntime,
} from '@/AI/AIAgent/shared/subAgents/types';

export async function startAgentChat(): Promise<void> {
    const memorySettings = await loadMemorySettings();
    let watcher: WatcherHandle | null = null;

    if (memorySettings.enabled && memorySettings.indexCodeOnSave) {
        try {
            watcher = await startWatcher();
        } catch (err) {
            console.warn(`kra-memory: watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const subAgentSettings = await loadSubAgentSettings();
    const allClients: AgentClient[] = [];
    let orchestrator: Awaited<ReturnType<typeof pickAgentRuntime>> | null = null;
    let executor: ExecutorRuntime | undefined;
    let investigator: InvestigatorRuntime | undefined;

    try {
        orchestrator = await pickAgentRuntime('orchestrator');
        allClients.push(orchestrator.client);

        if (subAgentSettings.executor.enabled) {
            const picked = await pickAgentRuntime('executor');
            allClients.push(picked.client);
            executor = {
                client: picked.client,
                model: picked.model,
                ...(picked.contextWindow !== undefined ? { contextWindow: picked.contextWindow } : {}),
                settings: subAgentSettings.executor,
            };
        }

        if (subAgentSettings.investigator.enabled) {
            const picked = await pickAgentRuntime('investigator');
            allClients.push(picked.client);
            investigator = {
                client: picked.client,
                model: picked.model,
                ...(picked.contextWindow !== undefined ? { contextWindow: picked.contextWindow } : {}),
                settings: subAgentSettings.investigator,
            };
        }

        await conversation.converseAgent({
            client: orchestrator.client,
            model: orchestrator.model,
            ...(orchestrator.contextWindow !== undefined ? { contextWindow: orchestrator.contextWindow } : {}),
            ...(orchestrator.kind === 'byok'
                ? { additionalMcpServers: buildByokExtraMcpServers() }
                : {}),
            ...(executor ? { executor } : {}),
            ...(investigator ? { investigator } : {}),
        });
    } catch (error) {
        for (const c of allClients) {
            await c.forceStop?.().catch(() => { /* best effort */ });
        }
        throw error;
    } finally {
        if (watcher) await watcher.close();
    }
}
