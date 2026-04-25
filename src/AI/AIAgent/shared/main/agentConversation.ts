import * as fs from 'fs/promises';
import path from 'path';
import { getConfiguredMcpServers } from '@/AI/AIAgent/shared/utils/agentSettings';
import {
    createProposalWorkspace,
    hasProposalChanges,
    removeProposalWorkspace,
} from '@/AI/AIAgent/shared/utils/proposalWorkspace';
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

    if (await hasProposalChanges(state.proposalWorkspace.workspacePath)) {
        console.log(`Unapplied proposal changes kept at ${state.proposalWorkspace.workspacePath}`);
    } else {
        await removeProposalWorkspace(
            state.proposalWorkspace.repoRoot,
            state.proposalWorkspace.workspacePath
        );
    }

    await fs.rm(state.chatFile, { force: true });
    await state.session.disconnect();
    await state.client.stop();
    process.exit(0);
}

export async function converseAgent(options: AgentConversationOptions): Promise<void> {
    fileContext.clearFileContexts();

    const proposalWorkspace = await createProposalWorkspace();
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
    };
    const stateRef: { current?: AgentConversationState } = {};
    const mergedMcpServers = {
        ...mcpServers,
        ...(options.additionalMcpServers ?? {}),
    };
    const session = await options.client.createSession({
        model: options.model,
        workingDirectory: proposalWorkspace.workspacePath,
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
**Check file size FIRST to choose the right workflow.**

For small files (≤150 lines):
  1. Call read_lines for the entire file — the tool rejects it if >150 lines and tells you to call get_outline first
  2. No outline step needed

For large files (>150 lines):
  1. Call get_outline to see line count + symbol locations (shows which functions/classes are where)
  2. Find the exact range you need (use the line numbers from get_outline)
  3. Call read_lines ONLY on that specific range
  4. Example: if you see a function starts at line 203 and ends at line 215, read_lines start_line:203 end_line:215 — not the whole file

**Why this matters:** When you read more than you need, you waste tokens. The outline tells you exactly where to look, so use it to find the minimal range, then read only that range.

Reading data files (JSON/YAML/TOML/MD/.env/logs):
  - Always call get_outline first to see line count
  - Then read_lines on a targeted range, not the whole file
  - Example: For a large log file (500 lines), don't read all 500. Read around the error line you're looking for.

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

Reminder: Always call confirm_task_complete before ending your turn.`,
        },
    });


    const state: AgentConversationState = {
        chatFile,
        model: options.model,
        client: options.client,
        session,
        nvim: nvimClient,
        proposalWorkspace,
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
