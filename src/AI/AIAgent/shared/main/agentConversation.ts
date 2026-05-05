import * as fs from 'fs/promises';
import { execCommand } from '@/utils/bashHelper';
import { createAgentHistory } from '@/AI/AIAgent/shared/utils/agentHistory';
import { buildCoreMcpServers } from '@/AI/AIAgent/mcp/serverConfig';
import * as conversation from '@/AI/shared/conversation';
import type {
    AgentConversationOptions,
    AgentConversationState,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentPostToolUseHookInput,
    AgentPostToolUseHookOutput,
    LocalTool,
} from '@/AI/AIAgent/shared/types/agentTypes';
import { createInvestigateTool } from '@/AI/AIAgent/shared/subAgents/investigateTool';
import { createExecuteTool } from '@/AI/AIAgent/shared/subAgents/executeTool';
import { createOrchestratorTranscript } from '@/AI/AIAgent/shared/main/orchestratorTranscript';

import { handleAgentUserInput, handlePreToolUse } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { runStartupIndexingFlow } from '@/AI/AIAgent/shared/main/agentIndexingFlow';
import { setupSessionEventHandlers, updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import {
    addAgentCommands,
    addAgentFunctions,
    createAgentChatFile,
    focusAgentPrompt,
    openAgentNeovim,
    refreshAgentLayout,
    setupAgentSplitLayout,
} from '@/AI/AIAgent/shared/main/agentNeovimSetup';
import { getErrorMessage, setupEventHandlers } from '@/AI/AIAgent/shared/main/agentPromptActions';

const aiNeovimHelper = conversation;
const fileContext = conversation;

async function cleanup(state: AgentConversationState): Promise<void> {
    fileContext.clearFileContexts();
    await updateAgentUi(state.nvim, 'finish_turn');

    const changedCount = state.history.listChangedPaths().length;
    if (changedCount > 0) {
        console.log(`${changedCount} file(s) touched by agent (run rejectProposal to revert).`);
    }

    await fs.rm(state.chatFile, { force: true });
    await state.session.disconnect();
    await state.client.stop();
    process.exit(0);
}

export async function converseAgent(options: AgentConversationOptions): Promise<void> {
    fileContext.clearFileContexts();

    const cwd = (await execCommand('git rev-parse --show-toplevel')).stdout.trim();
    const history = createAgentHistory(cwd);
    const chatFile = `/tmp/kra-agent-chat-${Date.now()}.md`;
    await createAgentChatFile(chatFile);

    const nvimClient = await openAgentNeovim(chatFile);
    await runStartupIndexingFlow(nvimClient, cwd);

    const mcpServers = await buildCoreMcpServers();
    const stateRef: { current?: AgentConversationState } = {};
    const mergedMcpServers = {
        ...mcpServers,
        ...(options.additionalMcpServers ?? {}),
    };
    const orchestratorOnPreToolUse = async (input: AgentPreToolUseHookInput): Promise<AgentPreToolUseHookOutput> => {
        if (!stateRef.current) {
            return {
                permissionDecision: 'deny',
                permissionDecisionReason: 'Agent UI is not ready yet.',
            };
        }

        try {
            return await handlePreToolUse(stateRef.current, input);
        } catch (error) {
            await updateAgentUi(stateRef.current.nvim, 'show_error', [
                `Pre-tool approval failed: ${input.toolName}`,
                getErrorMessage(error),
            ]);

            return {
                permissionDecision: 'deny',
                permissionDecisionReason: `Pre-tool approval failed: ${getErrorMessage(error)}`,
            };
        }
    };

    const orchestratorOnPostToolUse = async (input: AgentPostToolUseHookInput): Promise<AgentPostToolUseHookOutput> => {
        const isBashLike = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
            (fragment) => input.toolName.toLowerCase().includes(fragment)
        );

        if (isBashLike && stateRef.current?.pendingBashSnapshot) {
            const snapshot = stateRef.current.pendingBashSnapshot;

            delete (stateRef.current as Partial<AgentConversationState>).pendingBashSnapshot;
            await stateRef.current.history.bashSnapshotAfter(snapshot).catch(() => { /* non-fatal */ });
        }

        const HEAD_CHARS = isBashLike ? 2000 : 4000;
        const TAIL_CHARS = isBashLike ? 6000 : 4000;
        const text = input.toolResult.textResultForLlm;
        if (text.length <= HEAD_CHARS + TAIL_CHARS) return {};
        const omitted = text.length - HEAD_CHARS - TAIL_CHARS;

        return {
            modifiedResult: {
                ...input.toolResult,
                textResultForLlm: [
                    text.slice(0, HEAD_CHARS),
                    `\n…[${omitted} chars omitted]…\n`,
                    text.slice(text.length - TAIL_CHARS),
                ].join(''),
            },
        };
    };

    const orchestratorLocalTools: LocalTool[] = [];

    if (options.investigator) {
        orchestratorLocalTools.push(createInvestigateTool({
            runtime: options.investigator,
            mcpServers: mergedMcpServers,
            workingDirectory: cwd,
            chatBridge: {
                getParentState: () => {
                    if (!stateRef.current) {
                        throw new Error('Investigator invoked before orchestrator state was ready');
                    }

                    return stateRef.current;
                },
                agentLabel: 'INVESTIGATOR',
                headerEmoji: '🔍',
                parentOnPreToolUse: orchestratorOnPreToolUse,
                parentOnPostToolUse: orchestratorOnPostToolUse,
            },
        }));
    }

    if (options.executor) {
        orchestratorLocalTools.push(createExecuteTool({
            runtime: options.executor,
            mcpServers: mergedMcpServers,
            workingDirectory: cwd,
            chatBridge: {
                getParentState: () => {
                    if (!stateRef.current) {
                        throw new Error('Executor invoked before orchestrator state was ready');
                    }

                    return stateRef.current;
                },
                agentLabel: 'EXECUTOR',
                headerEmoji: '⚙️',
                parentOnPreToolUse: orchestratorOnPreToolUse,
                parentOnPostToolUse: orchestratorOnPostToolUse,
            },
        }));
    }

    const session = await options.client.createSession({
        model: options.model,
        workingDirectory: cwd,
        mcpServers: mergedMcpServers,
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob', 'create', 'apply_patch', 'report_intent', ...(options.provider === 'byok' ? ['confirm_task_complete'] : [])],
        ...(orchestratorLocalTools.length > 0 ? { localTools: orchestratorLocalTools } : {}),
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
        ...(options.modelCapabilities ? { modelCapabilities: options.modelCapabilities } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
        ...(options.dynamicParams ? { dynamicParams: options.dynamicParams } : {}),
        onPreToolUse: orchestratorOnPreToolUse,
        onPostToolUse: orchestratorOnPostToolUse,
        onUserInputRequest: async (request) => handleAgentUserInput(
            nvimClient,
            request.question as string,
            request.choices as string[] | undefined,
            (request.allowFreeform as boolean | undefined) ?? true
        ),

        systemMessage: {
            mode: 'append',
            content: buildOrchestratorSystemMessage({
                investigateEnabled: !!options.investigator,
                executeEnabled: !!options.executor,
                isCopilot: options.provider === 'copilot',
            }),
        },
    });


    const state: AgentConversationState = {
        chatFile,
        model: options.model,
        client: options.client,
        session,
        nvim: nvimClient,
        cwd,
        history,
        isStreaming: false,
        approvalMode: 'strict',
        allowedToolFamilies: new Set<string>(),
        transcript: createOrchestratorTranscript(),
    };
    stateRef.current = state;

    // ── Orchestrator transcript capture ──────────────────────────────────────
    // Listen on the orchestrator session for assistant text / tool calls and
    // mirror them into `state.transcript`. The transcript is later sliced and
    // injected into the executor sub-agent's task prompt (see executeTool.ts)
    // so the executor inherits the orchestrator's prior file reads + findings
    // without re-fetching them.
    const pendingToolCalls = new Map<string, { toolName: string; args: unknown }>();
    let assistantBuffer = '';

    const flushAssistantBuffer = (): void => {
        if (assistantBuffer.length === 0) return;

        state.transcript.appendAssistant(assistantBuffer);
        assistantBuffer = '';
    };

    // Capture only the final reply text (`assistant.message_delta`), NOT the
    // chain-of-thought stream (`assistant.reasoning_delta`). Per Anthropic's
    // guidance, prior thinking blocks are private scratchpad and should not be
    // re-fed as input — they contain false starts and bloat the prompt, and
    // the executor (a fresh model invocation) does its own reasoning anyway.
    session.on('assistant.message_delta', (event) => {
        const delta = (event.data as { deltaContent?: string }).deltaContent;

        if (typeof delta === 'string') {
            assistantBuffer += delta;
        }
    });

    session.on('tool.execution_start', (event) => {
        flushAssistantBuffer();

        const data = event.data as {
            toolCallId: string;
            toolName: string;
            mcpToolName?: string;
            arguments?: unknown;
        };
        // Prefer the bare MCP tool name when available (so suffix-based filters
        // in `buildExecutorTranscript` match cleanly across providers).
        const toolName = data.mcpToolName ?? data.toolName;

        pendingToolCalls.set(data.toolCallId, {
            toolName,
            args: data.arguments,
        });
    });

    session.on('tool.execution_complete', (event) => {
        const data = event.data as {
            toolCallId: string;
            success: boolean;
            result?: { content?: string; detailedContent?: string };
            error?: unknown;
        };
        const pending = pendingToolCalls.get(data.toolCallId);

        pendingToolCalls.delete(data.toolCallId);

        if (!pending) return;

        const result = data.success
            ? (data.result?.detailedContent ?? data.result?.content ?? '')
            : (data.error !== undefined ? String(data.error) : '');

        state.transcript.appendToolCall({
            toolName: pending.toolName,
            args: pending.args,
            result,
            success: data.success,
        });
    });

    session.on('session.idle', () => {
        flushAssistantBuffer();
    });

    const channelId = await nvimClient.channelId;

    try {
        await aiNeovimHelper.addNeovimFunctions(nvimClient, channelId);
        await aiNeovimHelper.addCommands(nvimClient);
        await aiNeovimHelper.setupKeyBindings(nvimClient);
        await addAgentFunctions(nvimClient, channelId);
        await addAgentCommands(nvimClient);
        await nvimClient.command(`edit ${chatFile}`);
        // Enable fold markers for the tool-call log blocks (uses default {{{/}}} markers).
        // foldlevel=99 keeps all folds open by default; user can fold with zc/za.
        await nvimClient.command('setlocal foldmethod=marker foldlevel=99');
        await setupAgentSplitLayout(nvimClient, channelId, chatFile);
        await refreshAgentLayout(nvimClient);
        await focusAgentPrompt(nvimClient);
        await setupSessionEventHandlers(state);
        await setupEventHandlers(state);

        const executableTools = state.session.listExecutableTools?.() ?? [];
        await updateAgentUi(nvimClient, 'set_executable_tools', [executableTools]);

        let cleaningUp = false;
        const runCleanup = (): void => {
            if (cleaningUp) return;
            cleaningUp = true;
            cleanup(state).catch(() => process.exit(1));
        };

        nvimClient.on('disconnect', runCleanup);
        process.once('SIGINT', runCleanup);
        process.once('SIGTERM', runCleanup);
    } catch (error) {
        await cleanup(state);
        throw error;
    }
}

interface OrchestratorSystemMessageOpts {
    investigateEnabled: boolean;
    executeEnabled: boolean;
    isCopilot?: boolean;
}

export function buildOrchestratorSystemMessage(opts: OrchestratorSystemMessageOpts): string {
    const { investigateEnabled, executeEnabled } = opts;
    const anySubAgent = investigateEnabled || executeEnabled;
    const sections: string[] = [];

    if (opts.isCopilot) {
        sections.push(TURN_COMPLETION_BLOCK);
    }

    sections.push(WORKSPACE_BLOCK);

    if (anySubAgent) {
        sections.push(buildDelegationBlock(opts));
    }

    sections.push(buildReadingCodeBlock(anySubAgent));
    sections.push(buildSurgicalEditsBlock(executeEnabled));
    sections.push(CREATING_FILES_BLOCK);
    sections.push(buildLongTermMemoryBlock(investigateEnabled));

    if (opts.isCopilot) {
        sections.push('Reminder: Always call confirm_task_complete before ending your turn.');
    }

    return sections.join('\n\n');
}

const TURN_COMPLETION_BLOCK = `<turn_completion priority="critical">
End every turn by calling \`confirm_task_complete\` with a concise summary and 2–4 concrete choices — whether you finished, are blocked, or need clarification. Never end with plain text.
</turn_completion>`;

const WORKSPACE_BLOCK = `<workspace>
You are in a detached proposal workspace. Edits land in the real repository only after the user reviews the resulting git diff in Neovim, so edit files freely.
</workspace>`;

const CREATING_FILES_BLOCK = `<creating_files>
Use \`create_file\` for new files only. It refuses if the file already exists. For existing files, use the \`edit\` tool.
</creating_files>`;

function buildDelegationBlock(opts: OrchestratorSystemMessageOpts): string {
    const lines: string[] = ['<delegation priority="high">'];

    lines.push('Sub-agents available — use them to keep your context lean:');
    lines.push('');

    if (opts.investigateEnabled) {
        lines.push('- `investigate` — LOCATION/FLOW questions only ("where is X?", "how does Y flow?"). NOT for diagnosis, root-cause, bug-hunting, or design judgement — those are YOUR job. Use it to gather evidence; reason about it yourself. Pass known context via `hint`.');
    }

    if (opts.executeEnabled) {
        const transcriptNote = opts.investigateEnabled
            ? 'a transcript of your prior `investigate` calls, file reads, and reasoning since the last execute'
            : 'a transcript of your prior file reads and reasoning since the last execute';

        lines.push(`- \`execute\` — concrete multi-step work (refactor, feature, multi-file edit). Returns ONLY a curated event log + summary; raw tool traffic stays out of your context. Do NOT copy findings/file contents into \`plan\` — the executor automatically receives ${transcriptNote}.`);
        lines.push('  - If executor returns `status: needs_decision`, it hit a real design crossroad. Present the `decisionPoint.question` (and `options[]` if any) to the user via `confirm_task_complete` — do NOT autonomously decide. Once the user picks, re-issue `execute` with an updated plan.');
    }

    lines.push('');
    lines.push('Do it yourself only for: a single trivial edit, or work needing orchestrator-grade reasoning at every step.');

    if (opts.investigateEnabled && opts.executeEnabled) {
        lines.push('Only ONE investigate and ONE execute can run at a time.');
    } else if (opts.investigateEnabled) {
        lines.push('Only ONE investigate can run at a time.');
    } else {
        lines.push('Only ONE execute can run at a time.');
    }

    lines.push('</delegation>');

    return lines.join('\n');
}

function buildReadingCodeBlock(delegateFirst: boolean): string {
    const preamble = delegateFirst
        ? 'Before raw reads, check if delegation (see <delegation>) fits. The rules below apply when you read directly.\n\n'
        : '';

    return `<reading_code>
${preamble}**Default: get_outline first to find the smallest range; then read_lines on that range.**

  - Files ≤150 lines: just read whole.
  - Known exact range ≤150 lines: read_lines directly.
  - Otherwise: get_outline → read_lines on the targeted range.
  - read_lines bounces requests >200 lines on files with a meaningful outline (use a tighter range, not multiple calls). Unstructured files (txt/csv/log/plain md) are never gated; 500-line hard cap.

Searching: use \`kra-file-context:search\` (grep/glob disabled). \`name_pattern\` for files, \`content_pattern\` for content.
</reading_code>`;
}

function buildSurgicalEditsBlock(executeEnabled: boolean): string {
    const preamble = executeEnabled
        ? 'These rules apply when you edit directly. For multi-file or multi-step edits, prefer delegating to `execute` (see <delegation>).\n\n'
        : '';

    return `<surgical_edits>
${preamble}**Edit ONLY the code that must change. Anchor each edit to surrounding content.**

The \`edit\` tool is anchor-based. Each entry in \`edits\` has:
  - \`op\`: "replace" | "insert" | "delete"
  - \`anchor\`: 1+ contiguous lines from the CURRENT file, VERBATIM (whitespace included). Must match EXACTLY ONCE. For ranges, anchor = first line.
  - \`end_anchor\` (replace/delete only, optional): last line of region. Both ends content-verified; everything between replaced.
  - \`position\` (insert only): "before" | "after". Default "after".
  - \`content\`: required for replace/insert. Do NOT include unchanged context.

If an anchor is ambiguous (e.g. \`}\`, \`return null;\`), widen UPWARD/DOWNWARD until unique — the error tells you how many places matched. Whitespace-trimmed fallback is auto-attempted; tool reports if used.

Multi-edit: pass several entries in one call. Anchors resolve against ORIGINAL file in parallel; engine applies bottom-to-top. Overlapping regions rejected. Order doesn't matter. Prefer one batched call over sequential calls to the same file.

**Examples:**

  Single line:
    { op: "replace", anchor: "const TIMEOUT_MS = 5000;", content: "const TIMEOUT_MS = 30000;" }

  Multi-line region with end_anchor:
    { op: "replace",
      anchor: "function oldImpl() {",
      end_anchor: "} // oldImpl",
      content: "function newImpl() {\n    return doIt();\n}" }

  Insert after an import:
    { op: "insert", anchor: "import { foo } from './foo';", position: "after",
      content: "import { bar } from './bar';" }

The anchor IS the contract — only matched region changes. Pick tight unique anchors; widen ONLY to disambiguate.
</surgical_edits>`;
}

function buildLongTermMemoryBlock(investigateEnabled: boolean): string {
    const discoveryRule = investigateEnabled
        ? `**Discovery first:** for any new non-trivial conceptual question (bug, feature, unfamiliar request), start with \`investigate\`. Use \`semantic_search\` directly only for memory-only lookups or quick scoped scans. Skip kickoff only when the user gave an exact file/symbol/path/string, or for tiny local edits. Use \`search\` for exact symbol/string/path lookups.`
        : `**Discovery first:** for any new non-trivial conceptual question, start with \`semantic_search({ query, scope: 'both', memoryKind: 'findings' })\`. Skip only when the user gave an exact file/symbol/path/string, or for tiny local edits. Use \`search\` for exact symbol/string/path lookups. Don't repeat broad semantic queries — if the first pass is weak, switch to targeted \`search\` / \`lsp_query\`.`;

    return `<long_term_memory priority="high">
Long-term memory (kra-memory) is your persistent vector store across sessions. TWO tables — always pass the correct \`kind\`:

**Findings** — \`kind\` ∈ { \`bug-fix\`, \`gotcha\`, \`decision\`, \`investigation\`, \`note\` }. Things you discover that a future session needs.
  - \`bug-fix\` root cause + fix; \`gotcha\` repo-specific trap; \`decision\` design choice + rationale; \`investigation\` reusable research result; \`note\` anything else.

**Revisits** — \`kind: 'revisit'\`. Deferred ideas. Status \`open\`/\`resolved\`/\`dismissed\`. Close via \`update_memory\`.

**Write proactively** after: fixing a non-obvious bug, hitting a gotcha, making a non-trivial design choice, completing a reusable investigation, or when the user defers an idea. Include enough detail in \`body\` that a future session can act without re-investigating. Always set \`paths\` when relevant.

${discoveryRule}

**Reading memory:**
- \`recall({ kind, query?, tagsAny?, status? })\` — \`kind\` required. With \`query\` runs vector search; without, list mode (newest first). Use mainly for listing/filtering revisits.
- \`semantic_search({ query, scope?, memoryKind?, pathGlob? })\` — conceptual search. \`scope\` is \`code\` (default) / \`memory\` / \`both\`. Preferred first-step discovery tool.
- \`edit_memory\` to refine in place (re-embeds on title/body change) instead of creating duplicates.
</long_term_memory>`;
}
