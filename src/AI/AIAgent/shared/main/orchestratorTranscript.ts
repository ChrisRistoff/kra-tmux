/**
 * Orchestrator transcript — a chronological log of what the orchestrator
 * actually said and did during a turn.
 *
 * The transcript is used by the executor sub-agent: when the orchestrator
 * calls `execute`, we hand the executor a slice of the transcript covering
 * everything since the last `execute` call (or everything, if none). That
 * way the executor can see the orchestrator's prior file reads, search
 * results, investigation findings, and reasoning text directly — instead
 * of relying on the orchestrator to manually summarise them into a
 * `context` blob.
 *
 * Capture sources (wired in `agentConversation.ts`):
 *   - User submissions  → `appendUser()` (called from the prompt submit handler)
 *   - Assistant text    → buffered from `assistant.message_delta`, flushed on
 *                         `tool.execution_start` / `session.idle` via
 *                         `appendAssistant()`
 *   - Tool calls        → `tool.execution_start` records pending args;
 *                         `tool.execution_complete` finalises the entry via
 *                         `appendToolCall()`
 *
 * The transcript is provider-agnostic: it consumes only events declared in
 * `AgentSessionEventMap`, so both BYOK (OpenAI) and Copilot (Anthropic)
 * provider sessions populate it identically.
 */

export type TranscriptEntry =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'tool_call'; toolName: string; args: unknown; result: string; success: boolean };

export interface OrchestratorTranscript {
    /** Append a user submission. */
    appendUser: (text: string) => void;
    /** Append accumulated assistant reasoning text (no-op if empty/whitespace). */
    appendAssistant: (text: string) => void;
    /** Append a completed tool call with its result. */
    appendToolCall: (entry: { toolName: string; args: unknown; result: string; success: boolean }) => void;
    /**
     * Get every transcript entry recorded after the last `execute` tool call
     * (or all entries if no prior execute). The returned array is a shallow
     * copy — callers may not mutate internal state.
     */
    sliceSinceLastExecute: () => TranscriptEntry[];
    /** All entries (for debugging / tests). */
    all: () => TranscriptEntry[];
}

export function createOrchestratorTranscript(): OrchestratorTranscript {
    const entries: TranscriptEntry[] = [];

    return {
        appendUser(text) {
            const trimmed = text.trim();

            if (trimmed.length === 0) return;

            entries.push({ kind: 'user', text: trimmed });
        },

        appendAssistant(text) {
            const trimmed = text.trim();

            if (trimmed.length === 0) return;

            entries.push({ kind: 'assistant', text: trimmed });
        },

        appendToolCall({ toolName, args, result, success }) {
            entries.push({ kind: 'tool_call', toolName, args, result, success });
        },

        sliceSinceLastExecute() {
            // Walk backwards looking for the last `execute` tool_call entry.
            // Tool names from Copilot may carry a server prefix like
            // `kra-subagent__execute` or `kra-subagent-execute`, so we match
            // on a trailing `execute` segment delimited by `-`, `__`, or `.`.
            for (let i = entries.length - 1; i >= 0; i--) {
                const e = entries[i];

                if (e.kind === 'tool_call' && isExecuteToolName(e.toolName)) {
                    return entries.slice(i + 1);
                }
            }

            return entries.slice();
        },

        all() {
            return entries.slice();
        },
    };
}

function isExecuteToolName(toolName: string): boolean {
    if (toolName === 'execute') return true;

    return /(^|[\-.]|__)execute$/.test(toolName);
}
