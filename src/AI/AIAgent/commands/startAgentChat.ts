/**
 * Top-level entry point for starting an AI agent chat session.
 *
 * Picker order (matches what the user sees on the screen):
 *   1. Orchestrator provider → (BYOK only) model provider → model
 *      → (Copilot only) reasoning effort
 *   2. Investigator (if enabled) → same picker.
 *   3. Executor (if enabled) → same picker, UNLESS
 *      `[ai.agent.executor].useInvestigatorRuntime = true` (and the investigator
 *      is enabled), in which case the executor reuses the investigator's
 *      resolved client + model and the picker is skipped.
 *
 * Provider-specific concerns are kept tight:
 *   - BYOK orchestrators get the kra-bash + kra-web MCP servers attached.
 *   - Copilot has those tools natively and does not need them re-attached.
 */

import * as conversation from '@/AI/AIAgent/shared/main/agentConversation';
import { buildByokExtraMcpServers } from '@/AI/AIAgent/mcp/serverConfig';
import { loadSubAgentSettings } from '@/AI/AIAgent/shared/subAgents/settings';
import { pickAgentRuntime } from '@/AI/AIAgent/commands/subAgentProviderPicker';
import type { AgentClient } from '@/AI/AIAgent/shared/types/agentTypes';
import type {
    ExecutorRuntime,
    InvestigatorRuntime,
    WebInvestigatorRuntime,
} from '@/AI/AIAgent/shared/subAgents/types';

export async function startAgentChat(): Promise<void> {
    const subAgentSettings = await loadSubAgentSettings();
    const allClients: AgentClient[] = [];
    let orchestrator: Awaited<ReturnType<typeof pickAgentRuntime>> | null = null;
    let executor: ExecutorRuntime | undefined;
    let investigator: InvestigatorRuntime | undefined;
    let investigatorWeb: WebInvestigatorRuntime | undefined;

    try {
        orchestrator = await pickAgentRuntime('orchestrator');
        allClients.push(orchestrator.client);

        if (subAgentSettings.investigator.code) {
            const picked = await pickAgentRuntime('investigator');
            allClients.push(picked.client);
            investigator = {
                client: picked.client,
                model: picked.model,
                ...(picked.contextWindow !== undefined ? { contextWindow: picked.contextWindow } : {}),
                settings: subAgentSettings.investigator,
            };
        }

        if (subAgentSettings.investigator.web) {
            // Web investigator's runtime usually piggy-backs on the code
            // investigator (same cheap model). When `useInvestigatorRuntime`
            // is off OR the code investigator is somehow absent, fall through
            // to a dedicated picker so the user can select a different model.
            if (subAgentSettings.investigatorWeb.useInvestigatorRuntime && investigator) {
                investigatorWeb = {
                    client: investigator.client,
                    model: investigator.model,
                    ...(investigator.contextWindow !== undefined ? { contextWindow: investigator.contextWindow } : {}),
                    settings: subAgentSettings.investigatorWeb,
                };
            } else {
                const picked = await pickAgentRuntime('investigator');
                allClients.push(picked.client);
                investigatorWeb = {
                    client: picked.client,
                    model: picked.model,
                    ...(picked.contextWindow !== undefined ? { contextWindow: picked.contextWindow } : {}),
                    settings: subAgentSettings.investigatorWeb,
                };
            }
        }

        if (subAgentSettings.executor.enabled) {
            // If `useInvestigatorRuntime` is on AND we have an investigator,
            // skip the picker and reuse the investigator's resolved client +
            // model so the user only goes through the picker once.
            if (subAgentSettings.executor.useInvestigatorRuntime && investigator) {
                executor = {
                    client: investigator.client,
                    model: investigator.model,
                    ...(investigator.contextWindow !== undefined ? { contextWindow: investigator.contextWindow } : {}),
                    settings: subAgentSettings.executor,
                };
            } else {
                const picked = await pickAgentRuntime('executor');
                allClients.push(picked.client);
                executor = {
                    client: picked.client,
                    model: picked.model,
                    ...(picked.contextWindow !== undefined ? { contextWindow: picked.contextWindow } : {}),
                    settings: subAgentSettings.executor,
                };
            }
        }

        await conversation.converseAgent({
            provider: orchestrator.kind,
            client: orchestrator.client,
            model: orchestrator.model,
            ...(orchestrator.contextWindow !== undefined ? { contextWindow: orchestrator.contextWindow } : {}),
            ...(orchestrator.capabilities ? { modelCapabilities: orchestrator.capabilities } : {}),
            ...(orchestrator.reasoningEffort ? { reasoningEffort: orchestrator.reasoningEffort } : {}),
            ...(orchestrator.temperature != null ? { temperature: orchestrator.temperature } : {}),
            ...(orchestrator.dynamicParams ? { dynamicParams: orchestrator.dynamicParams } : {}),
            ...(orchestrator.kind === 'byok' || orchestrator.kind === 'claude'
                ? { additionalMcpServers: buildByokExtraMcpServers() }
                : {}),
            ...(executor ? { executor } : {}),
            ...(investigator ? { investigator } : {}),
            ...(investigatorWeb ? { investigatorWeb } : {}),
            truncation: subAgentSettings.truncation,
            subAgentTruncation: subAgentSettings.subAgentTruncation,
        });
    } catch (error) {
        for (const c of allClients) {
            await c.forceStop?.().catch(() => { /* best effort */ });
        }
        throw error;
    }
}

