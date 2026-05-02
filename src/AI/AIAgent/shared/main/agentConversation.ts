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
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob', 'create', 'apply_patch', 'report_intent'],
        ...(orchestratorLocalTools.length > 0 ? { localTools: orchestratorLocalTools } : {}),
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
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
        await setupAgentSplitLayout(nvimClient, channelId);
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
End every turn by calling \`confirm_task_complete\` with a concise summary and 2–4 concrete choices. This applies whether you finished, are blocked, need clarification, or are unsure what to do next. Never end a turn with plain text or without calling \`confirm_task_complete\` — the user relies on this signal to know when you are done and to respond appropriately.
</turn_completion>`;

const WORKSPACE_BLOCK = `<workspace>
You are in a detached proposal workspace. Edits land in the real repository only after the user reviews the resulting git diff in Neovim, so edit files freely.
</workspace>`;

const CREATING_FILES_BLOCK = `<creating_files>
Use \`create_file\` for new files only. It refuses if the file already exists. For existing files, use edit_lines.
</creating_files>`;

function buildDelegationBlock(opts: OrchestratorSystemMessageOpts): string {
    const lines: string[] = ['<delegation priority="high">'];

    lines.push('You have sub-agents available — use them to keep your own context lean:');
    lines.push('');

    if (opts.investigateEnabled) {
        lines.push('- `investigate` — for research questions ("where is X handled?", "what does Y do?", "how does Z work?"). Returns a curated summary + verified verbatim excerpts from a cheaper sub-agent model instead of dumping raw files into your context. Use it BEFORE doing your own broad searches/reads. Pass anything you already know via `hint`.');
    }

    if (opts.executeEnabled) {
        const transcriptNote = opts.investigateEnabled
            ? 'a transcript of your prior `investigate` calls, file reads, and reasoning since the last execute call'
            : 'a transcript of your prior file reads and reasoning since the last execute call';

        lines.push(`- \`execute\` — for any concrete multi-step body of work (refactor, feature, multi-file edit). The executor runs the work end-to-end and returns ONLY a curated event log + summary; the raw tool traffic never enters your context. You do NOT need to copy findings or file contents into the \`plan\` — the executor automatically receives ${transcriptNote}.`);
    }

    lines.push('');
    lines.push('Do it yourself only when:');
    lines.push('  - The task is a single trivial edit (one line, one file).');
    lines.push('  - The task genuinely requires orchestrator-grade reasoning at every step.');

    if (opts.investigateEnabled && opts.executeEnabled) {
        lines.push('  - You need to reason about an investigation result before acting on it.');
    }

    lines.push('');

    if (opts.investigateEnabled && opts.executeEnabled) {
        lines.push('Only ONE investigate and ONE execute can run at a time. Wait for an in-flight call before issuing another of the same kind.');
    } else if (opts.investigateEnabled) {
        lines.push('Only ONE investigate can run at a time. Wait for an in-flight call before issuing another.');
    } else {
        lines.push('Only ONE execute can run at a time. Wait for an in-flight call before issuing another.');
    }

    lines.push('</delegation>');

    return lines.join('\n');
}

function buildReadingCodeBlock(delegateFirst: boolean): string {
    const preamble = delegateFirst
        ? 'Before reaching for raw file reads, check if delegation (see <delegation>) is a better fit. The rules below apply when you do read directly.\n\n'
        : '';

    return `<reading_code>
${preamble}**Default to get_outline when you need a feel for a file. Only read raw lines once you know the exact range.**

Workflow:
  1. If you already know the exact range you need (e.g. from a previous outline, search hit, or LSP result) and it's ≤150 lines, call read_lines directly on that range.
  2. Otherwise call get_outline first to find the smallest range that contains what you need, then read_lines on that range.
  3. Small files (≤150 lines) you can just read whole — no outline step needed.

Hard rule: read_lines bounces any single call requesting >200 lines back to the outline, but only when the file has a meaningful outline (entries from the LSP or regex fallback). Truly unstructured files (txt, csv, log, plain markdown without headings, …) are never gated — read whatever range you need (subject to the 500-line hard cap). Don't try to bypass the gate on structured files with multiple calls — narrow your range instead.

**Why this matters:** Reading more than you need wastes tokens. The outline tells you exactly where to look, so use it to find the minimal range, then read only that range.

Reading data files (JSON/YAML/TOML/MD/.env/logs):
  - Use get_outline first to see line count and structure
  - Then read_lines on a targeted range, not the whole file

Searching:
  Use \`kra-file-context:search\` (replaces grep/glob, both disabled).
  Use \`name_pattern\` (glob) for file names, \`content_pattern\` (regex) for content.
  Results show line count — use that to decide if you need get_outline before read_lines.
</reading_code>`;
}

function buildSurgicalEditsBlock(executeEnabled: boolean): string {
    const preamble = executeEnabled
        ? 'These rules apply when you edit directly. For multi-file or multi-step edits, prefer delegating to `execute` (see <delegation>).\n\n'
        : '';

    return `<surgical_edits>
${preamble}**Goal: Edit ONLY the lines that must change. Do not rewrite surrounding context.**

Workflow:
  1. Call get_outline to find what you need
  2. Call read_lines on the EXACT range containing your change
  ⚠ You MUST read the target lines before editing — the tool rejects edits without a prior read.
  3. read_lines prefixes every line like \`  142: code here\` — use those numbers directly as startLine/endLine
  4. Call edit_lines with startLine and endLine as tight as possible

**Before calling edit_lines — declare your ranges:**
Output \`Editing: L14-15, L88-88, L142-145\`. **Every line in each range must change** — if a line is only there to preserve context, remove it from the range entirely (the tool keeps untouched lines automatically). If any range spans a whole function but only 1-2 lines change inside it, split into tight sub-ranges.


Critical rule: Every line between startLine and endLine will be REPLACED with your newContent.
  - If you read lines 100–180 and need to change only lines 142–145, call edit_lines with startLine:142 endLine:145
  - Do NOT include unchanged lines 100–141 and 146–180 in your newContent
  - If only line 88 changes, use startLine:88 endLine:88 (single-line range: 88–88)
  - Do NOT pass the whole 100-line range just because you read it
  - Do NOT use any other tool except edit_lines to change code in a file

For multiple changes in the same file:
  - Use the multi-edit array form with several tight ranges
  - Example: lines 12–12, lines 47–49, lines 88–88 all in one call
  - Do NOT combine them into a single large range

**Why this matters:** Every line in the range is replaced verbatim. Stale surrounding context silently overwrites newer code you didn't intend to change.
</surgical_edits>`;
}

function buildLongTermMemoryBlock(investigateEnabled: boolean): string {
    const discoveryRule = investigateEnabled
        ? `**Discovery-first rule:**
- For any new non-trivial conceptual question — bug, feature, unfamiliar request — start with the \`investigate\` sub-agent (see <delegation>). It will run searches and synthesise findings for you, returning verified excerpts instead of dumping raw files into your context.
- Use \`semantic_search\` directly for memory-only lookups (\`scope: 'memory', memoryKind: 'findings'\`) or for very quick scoped scans where you don't want a full sub-agent dispatch.
- Skip the kickoff entirely only when the user already gave an exact file, exact symbol, exact path, or literal string, or when the task is a tiny local edit.
- Use \`search\` for exact symbol/string/path lookups.`
        : `**Discovery-first rule:**
- For any new non-trivial bug, feature, investigation, or unfamiliar request, start with \`semantic_search({ query: <problem>, scope: 'both', memoryKind: 'findings' })\`.
- Skip that kickoff only when the user already gave an exact file, exact symbol, exact path, or literal string, or when the task is a tiny local edit.
- Do **not** start with \`kra-file-context:search\` for a new conceptual problem. Use \`search\` for exact symbol/string/path lookups; use \`semantic_search\` for questions like "where does this happen?", "what handles this?", or "what code path matches this behavior?".
- Do one broad semantic pass first. If it returns weak or noisy results, move on to targeted \`search\` / \`lsp_query\` instead of repeating broad semantic queries.`;

    return `<long_term_memory priority="high">
Long-term memory (kra-memory) is your persistent vector store across sessions. It is split into TWO physical tables, and you MUST pass the correct \`kind\` on every call — there is no implicit cross-table query.

**Findings table** — \`kind\` ∈ { \`note\`, \`bug-fix\`, \`gotcha\`, \`decision\`, \`investigation\` }
Things YOU discover while working that a future session will want to know. Status is irrelevant.
  - \`bug-fix\`     — root cause + fix you found for a non-obvious bug
  - \`gotcha\`      — repo-specific trap, surprising behavior, hidden coupling
  - \`decision\`    — design choice + the rationale ("we picked X over Y because…")
  - \`investigation\` — result of digging through code/docs to answer a question
  - \`note\`        — anything else worth preserving that doesn't fit above

**Revisits table** — \`kind\` = \`revisit\` only
Ideas discussed and intentionally deferred, awaiting human input. Have status \`open\` / \`resolved\` / \`dismissed\`. Update via \`update_memory\` (revisits only).

**When to write (be proactive, not stingy):**
- After fixing a non-obvious bug → \`remember({ kind: 'bug-fix', … })\`
- After hitting a gotcha that cost you time → \`remember({ kind: 'gotcha', … })\`
- After making a design decision a future session would re-derive → \`remember({ kind: 'decision', … })\`
- After non-trivial investigation whose result is reusable → \`remember({ kind: 'investigation', … })\`
- When the user defers an idea → \`remember({ kind: 'revisit', … })\`
Include enough detail in \`body\` that a future session can act without re-investigating. Always set \`paths\` when relevant.

${discoveryRule}

**When to read memory:**
- \`recall({ kind, query?, tagsAny?, status? })\` — \`kind\` is **required**. Use \`kind: 'findings'\` for long-term memories, \`kind: 'revisit'\` for parked discussions, or a specific finding kind to narrow the findings table. With \`query\`, it runs vector search. Without \`query\`, it uses list mode (newest first).
- Use \`recall\` mainly for listing/filtering or revisits — not as the first step for conceptual discovery when \`semantic_search\` fits.

**\`semantic_search\` — conceptual search across the codebase (and optionally memory):**
- \`semantic_search({ query, scope?, memoryKind?, pathGlob?, k? })\`
- \`scope\` is \`code\` (default), \`memory\`, or \`both\`. When \`scope\` includes memory, pass \`memoryKind: 'findings'\` for long-term memories, \`memoryKind: 'revisit'\` for parked discussions, or a specific finding kind to narrow the findings table.
- Prefer it as the **first-step discovery tool** for unfamiliar codebase questions and prior-memory retrieval.

**Editing & lifecycle:**
- \`edit_memory({ id, title?, body?, tags?, paths? })\` — refine an existing entry in place. Re-embeds the vector when \`title\` or \`body\` changes. Use this instead of creating a near-duplicate.
- \`update_memory({ id, status, resolution? })\` — close out a revisit (\`resolved\` or \`dismissed\`) once acted on.
</long_term_memory>`;
}
