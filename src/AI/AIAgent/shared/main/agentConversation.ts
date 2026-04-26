import * as fs from 'fs/promises';
import path from 'path';
import { getConfiguredMcpServers } from '@/AI/AIAgent/shared/utils/agentSettings';
import { execCommand } from '@/utils/bashHelper';
import { createAgentHistory } from '@/AI/AIAgent/shared/utils/agentHistory';
import * as aiNeovimHelper from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AI/shared/utils/conversationUtils/fileContexts';
import type {
    AgentConversationOptions,
    AgentConversationState,
    AgentPreToolUseHookInput,
    AgentPreToolUseHookOutput,
    AgentPostToolUseHookInput,
    AgentPostToolUseHookOutput,
} from '@/AI/AIAgent/shared/types/agentTypes';

import { handleAgentUserInput, handlePreToolUse } from '@/AI/AIAgent/shared/utils/agentToolHook';
import { setupSessionEventHandlers, updateAgentUi } from '@/AI/AIAgent/shared/utils/agentSessionEvents';
import {
    addAgentCommands,
    addAgentFunctions,
    createAgentChatFile,
    openAgentNeovim,
    setupAgentKeyBindings,
} from '@/AI/AIAgent/shared/main/agentNeovimSetup';
import { getErrorMessage, setupEventHandlers } from '@/AI/AIAgent/shared/main/agentPromptActions';



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
    const userMcpServers = await getConfiguredMcpServers();
    const mcpServers = {
        ...userMcpServers,
        'kra-session-complete': {
            type: 'stdio' as const,
            command: process.execPath,
            args: [path.join(__dirname, '..', 'utils', 'sessionCompleteMcpServer.js')],
            tools: ['confirm_task_complete'],
        },
        'kra-file-context': {
            type: 'stdio' as const,
            command: process.execPath,
            args: [path.join(__dirname, '..', 'utils', 'fileContextMcpServer.js')],
            tools: ['get_outline', 'read_lines', 'read_function', 'edit_lines', 'create_file', 'search', 'lsp_query'],
        },
        'kra-memory': {
            type: 'stdio' as const,
            command: process.execPath,
            args: [path.join(__dirname, '..', 'utils', 'memoryMcpServer.js')],
            tools: ['remember', 'recall', 'update_memory', 'edit_memory', 'semantic_search'],
        },
    };
    const stateRef: { current?: AgentConversationState } = {};
    const mergedMcpServers = {
        ...mcpServers,
        ...(options.additionalMcpServers ?? {}),
    };
    const session = await options.client.createSession({
        model: options.model,
        workingDirectory: cwd,
        mcpServers: mergedMcpServers,
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob', 'create'],
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
        onPreToolUse: async (input: AgentPreToolUseHookInput): Promise<AgentPreToolUseHookOutput> => {
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
        },
        onPostToolUse: async (input: AgentPostToolUseHookInput): Promise<AgentPostToolUseHookOutput> => {
            // Bash/shell output: errors and summaries land at the tail, so bias
            // toward keeping more of the end.  All other tools use a 50/50 split.
            const isBashLike = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
                (fragment) => input.toolName.toLowerCase().includes(fragment)
            );

            // Run bash post-snapshot if pre-snapshot was taken.
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
        },

        onUserInputRequest: async (request) => handleAgentUserInput(
            nvimClient,
            request.question as string,
            request.choices as string[] | undefined,
            (request.allowFreeform as boolean | undefined) ?? true
        ),

        systemMessage: {
            mode: 'append',
            content: `<turn_completion priority="critical">
End every turn by calling \`confirm_task_complete\` with a concise summary and 2–4 concrete choices. This applies whether you finished, are blocked, need clarification, or are unsure what to do next. Never end a turn with plain text or without calling \`confirm_task_complete\` — the user relies on this signal to know when you are done and to respond appropriately.
</turn_completion>

<workspace>
You are in a detached proposal workspace. Edits land in the real repository only after the user reviews the resulting git diff in Neovim, so edit files freely.
</workspace>

<reading_code>
**Default to get_outline when you need a feel for a file. Only read raw lines once you know the exact range.**

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
</reading_code>

<surgical_edits>
**Goal: Edit ONLY the lines that must change. Do not rewrite surrounding context.**

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

For multiple changes in the same file:
  - Use the multi-edit array form with several tight ranges
  - Example: lines 12–12, lines 47–49, lines 88–88 all in one call
  - Do NOT combine them into a single large range

**Why this matters:** Every line in the range is replaced verbatim. Stale surrounding context silently overwrites newer code you didn't intend to change.
</surgical_edits>

<creating_files>
Use \`create_file\` for new files only. It refuses if the file already exists. For existing files, use edit_lines.
</creating_files>

<long_term_memory priority="high">
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

**When to read:**
- \`recall({ kind, query?, tagsAny?, status? })\` — \`kind\` is **required**. With \`query\`: vector search. Without \`query\`: list mode (newest first), e.g. \`recall({ kind: 'revisit', status: 'open' })\` to surface open revisits at session start in a familiar area.
- Call \`recall\` at the start of work in a familiar area, or whenever you suspect past context exists.

**\`semantic_search\` — conceptual search across the codebase (and optionally memory):**
- \`semantic_search({ query, scope?, memoryKind?, pathGlob?, k? })\`
- \`scope\` is \`code\` (default), \`memory\`, or \`both\`. **When \`scope\` includes memory, \`memoryKind\` is required** (which table to search).
- Use it for "where does X happen" / "what handles Y" when you don't know the exact symbol — it returns ranked snippets with file/line/language. Pair with \`read_lines\` / \`get_outline\` for full context.
- For known string/symbol lookups, prefer \`kra-file-context:search\` (ripgrep). The two are complementary.

**Editing & lifecycle:**
- \`edit_memory({ id, title?, body?, tags?, paths? })\` — refine an existing entry in place. Re-embeds the vector when \`title\` or \`body\` changes. Use this instead of creating a near-duplicate.
- \`update_memory({ id, status, resolution? })\` — close out a revisit (\`resolved\` or \`dismissed\`) once acted on.
</long_term_memory>

Reminder: Always call confirm_task_complete before ending your turn.`,
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
    };
    stateRef.current = state;

    const channelId = await nvimClient.channelId;

    try {
        await aiNeovimHelper.addNeovimFunctions(nvimClient, channelId);
        await aiNeovimHelper.addCommands(nvimClient);
        await aiNeovimHelper.setupKeyBindings(nvimClient);
        await addAgentFunctions(nvimClient, channelId);
        await addAgentCommands(nvimClient);
        await setupAgentKeyBindings(nvimClient);
        await nvimClient.command(`edit ${chatFile}`);
        // Enable fold markers for the tool-call log blocks (uses default {{{/}}} markers).
        // foldlevel=99 keeps all folds open by default; user can fold with zc/za.
        await nvimClient.command('setlocal foldmethod=marker foldlevel=99');
        await aiNeovimHelper.updateNvimAndGoToLastLine(nvimClient);
        await setupSessionEventHandlers(state);
        await setupEventHandlers(state);

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
