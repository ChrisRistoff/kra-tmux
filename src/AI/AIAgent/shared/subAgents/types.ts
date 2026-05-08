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
    /** Enables the code-investigator (`investigate`) sub-agent. */
    code: boolean;
    /** Enables the web-investigator (`investigate_web`) sub-agent. */
    web: boolean;
    maxEvidenceItems: number;
    maxExcerptLines: number;
    validateExcerpts: boolean;
    toolWhitelist: string[];
}

/**
 * Tuning knobs for the `investigate_web` autonomous web-research sub-agent.
 * The on/off switch lives on `InvestigatorSettings.web`; this block only
 * configures behaviour when that switch is on.
 *
 * Quotas are upper bounds; the sub-agent is also bound by `maxToolCalls`.
 */
export interface WebInvestigatorSettings {
    /**
     * If true AND the code-side investigator is enabled, the web investigator
     * reuses its resolved runtime (client + model) instead of prompting for a
     * separate provider/model on startup. Mirrors `executor.useInvestigatorRuntime`.
     */
    useInvestigatorRuntime: boolean;
    /** Hard cap on `web_search` calls per investigation. */
    maxSearches: number;
    /** Hard cap on `web_scrape_and_index` calls per investigation. */
    maxScrapes: number;
    /** Per-call cap on URLs passed to `web_scrape_and_index`. */
    urlsPerScrape: number;
    /** Hard cap on total tool calls before the agent is forced to submit. */
    maxToolCalls: number;
    maxEvidenceItems: number;
    maxExcerptLines: number;
    /** Time-to-live for indexed research_chunks rows, in minutes. */
    ttlMinutes: number;
    /** Whether to reject submitted evidence whose excerpts can't be located. */
    validateExcerpts: boolean;
    toolWhitelist: string[];
}

/**
 * Caps on tool-result text handed back to a model. Anything longer than
 * `defaultHead + defaultTail` (or `bashHead + bashTail` for bash-like tools)
 * gets the middle replaced with an omission marker. Set the head/tail to 0
 * to disable truncation entirely for that bucket. Tool names matching any
 * substring in `neverTruncate` bypass the cap completely.
 */
export interface AgentTruncationSettings {
    defaultHead: number;
    defaultTail: number;
    bashHead: number;
    bashTail: number;
    /** Substrings; a tool name containing any of these is never truncated. */
    neverTruncate: string[];
}

export interface SubAgentSettings {
    executor: ExecutorSettings;
    investigator: InvestigatorSettings;
    investigatorWeb: WebInvestigatorSettings;
    /** Truncation applied to tool results returned to the orchestrator. */
    truncation: AgentTruncationSettings;
    /**
     * Truncation applied to tool results returned to a sub-agent
     * (investigator / executor / investigator_web). Sub-agents typically need
     * to digest larger payloads, so defaults are looser than the orchestrator.
     */
    subAgentTruncation: AgentTruncationSettings;
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

export interface WebInvestigatorRuntime extends SubAgentRuntime {
    settings: WebInvestigatorSettings;
}
