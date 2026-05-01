/**
 * Types for the optional executor and investigator sub-agents.
 *
 * Both are off by default. When `enabled = true` in `settings.toml`, the BYOK
 * start flow prompts the user to pick a provider + model for that sub-agent
 * after the orchestrator has been chosen.
 *
 * The runtime config (`SubAgentRuntime`) carries the resolved client + model
 * id and the relevant behaviour knobs from settings; it gets threaded through
 * `AgentConversationOptions` into the orchestrator session.
 */

import type { AgentClient } from '@/AI/AIAgent/shared/types/agentTypes';

export interface ExecutorSettings {
    enabled: boolean;
    /**
     * If true AND the investigator is also enabled, the executor reuses the
     * investigator's resolved runtime (client + model) instead of prompting the
     * user to pick a separate provider/model on startup. Saves a picker step
     * when the user wants both sub-agents to run on the same cheap model.
     */
    useInvestigatorRuntime: boolean;
    allowInterrupt: boolean;
    allowReplanEscape: boolean;
    includeDiffsInLog: boolean;
    /** Hard cap on tool calls before the executor is forced to submit. */
    maxToolCalls: number;
    toolWhitelist: string[];
}

export interface InvestigatorSettings {
    enabled: boolean;
    maxEvidenceItems: number;
    maxExcerptLines: number;
    validateExcerpts: boolean;
    toolWhitelist: string[];
}

export interface SubAgentSettings {
    executor: ExecutorSettings;
    investigator: InvestigatorSettings;
}

export interface SubAgentRuntime {
    client: AgentClient;
    model: string;
    contextWindow?: number;
}

export interface ExecutorRuntime extends SubAgentRuntime {
    settings: ExecutorSettings;
}

export interface InvestigatorRuntime extends SubAgentRuntime {
    settings: InvestigatorSettings;
}
