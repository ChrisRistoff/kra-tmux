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
End every turn by calling \`confirm_task_complete\` with a concise summary and 2–4 concrete choices. This applies whether you finished, are blocked, need clarification, or are unsure what to do next. Never end a turn with plain text or without calling \`confirm_task_complete\` — the user relies on this signal to know when you are done and to respond appropriately.
</turn_completion>`;

const WORKSPACE_BLOCK = `<workspace>
You are in a detached proposal workspace. Edits land in the real repository only after the user reviews the resulting git diff in Neovim, so edit files freely.
</workspace>`;

const CREATING_FILES_BLOCK = `<creating_files>
Use \`create_file\` for new files only. It refuses if the file already exists. For existing files, use the \`edit\` tool.
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
${preamble}**Goal: Edit ONLY the code that must change. Anchor each edit to the surrounding content.**

The \`edit\` tool is anchor-based, not line-based. You pass:
  - \`file_path\`
  - \`edits\`: an array of one or more edits, each with:
    - \`op\`: "replace" | "insert" | "delete"
    - \`anchor\`: 1+ contiguous lines from the CURRENT file (verbatim, including indentation). Must match exactly once. For ranges, set the anchor to the FIRST line of the region.
    - \`end_anchor\`: optional, replace/delete only. Last line of the region (verbatim, must match exactly once after the anchor). When omitted on replace/delete, only the single \`anchor\` block is targeted.
    - \`position\`: "before" | "after" — insert only. Default "after".
    - \`content\`: required for replace/insert. The replacement / inserted text. Omit or pass empty for delete.

Why this is better than line numbers: the anchor is content-verified at apply time. If the file has shifted since you last looked, or if your anchor is ambiguous, the edit is rejected with a clear error — you can never silently overwrite the wrong region.

Workflow:
  1. Use get_outline / read_lines / search to find the code you want to change.
  2. Pick the SMALLEST anchor that uniquely identifies the change site — usually 1–3 lines is enough.
  3. For a replace/delete that spans many lines, set \`anchor\` to the first line and \`end_anchor\` to the last line of the region. Both ends are content-verified; everything between them is replaced.
  4. For an insert, choose \`position: "before"\` or \`"after"\` relative to the anchor.

**Anchor rules:**
  - Anchors must match the file VERBATIM (whitespace and indentation included). If your strict anchor matches zero times but a whitespace-trimmed version matches exactly once, the tool will fall back to the trimmed match and tell you in the response.
  - Anchor must match EXACTLY ONCE in the file. If a 1-line anchor would be ambiguous (e.g. \`return null;\`, \`}\`, an empty line, a common log call), extend it UPWARD or DOWNWARD with surrounding lines until it's unique. The tool's error tells you how many places matched, so widen and retry.
  - Blank or whitespace-only anchors are rejected.
  - For a replace/delete with \`end_anchor\`, the two anchor blocks must NOT overlap and \`end_anchor\` must come after \`anchor\` in the file.

**Examples:**

  Replace a single line — pick a unique 1-liner:
    { op: "replace", anchor: "const TIMEOUT_MS = 5000;", content: "const TIMEOUT_MS = 30000;" }

  Replace a duplicate line by widening the anchor (multiple \`return null;\` in the file):
    { op: "replace",
      anchor: "if (!user) {\n    return null;\n}",
      content: "if (!user) {\n    throw new UnauthorizedError();\n}" }

  Replace a multi-line region with end_anchor:
    { op: "replace",
      anchor: "function oldImpl() {",
      end_anchor: "} // oldImpl",
      content: "function newImpl() {\n    return doIt();\n}" }

  Insert a new import after the last existing import:
    { op: "insert",
      anchor: "import { foo } from './foo';",
      position: "after",
      content: "import { bar } from './bar';" }

  Delete a block:
    { op: "delete", anchor: "// DEPRECATED:\nfunction legacy() {", end_anchor: "} // legacy" }

**Multi-edit (one call, several changes):**
  - Pass several edits in the \`edits\` array of a single call. All anchors resolve against the ORIGINAL file in parallel; the engine applies them bottom-to-top so earlier edits don't shift later anchors.
  - Overlapping target regions are rejected — keep each edit's region disjoint from the others.
  - Order in the array does not matter. Prefer one batched call over multiple sequential ones when changing the same file in several places (one diff, one LSP pass, atomic).

**Critical rule:** the anchor IS the contract. Only the matched region is changed — surrounding code is preserved untouched. Do NOT include unchanged context inside \`content\`; do NOT widen an anchor just to "feel safe" (widen ONLY to disambiguate).

**Why this matters:** the only way to overwrite the wrong code is to feed a wrong anchor. Pick tight, unique anchors and the tool catches your mistakes for you.
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
