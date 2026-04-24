import * as fs from 'fs/promises';
import path from 'path';

import { aiRoles } from '@/AI/shared/data/roles';
import { getConfiguredMcpServers } from '@/AI/AIAgent/utils/agentSettings';
import {
    createProposalWorkspace,
    hasProposalChanges,
    removeProposalWorkspace,
} from '@/AI/AIAgent/utils/proposalWorkspace';
import * as aiNeovimHelper from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AI/shared/utils/conversationUtils/fileContexts';
import type { AgentConversationOptions, AgentConversationState } from '@/AI/AIAgent/types/agentTypes';
import { handleAgentUserInput, handlePreToolUse } from '@/AI/AIAgent/utils/agentToolHook';
import { setupSessionEventHandlers, updateAgentUi } from '@/AI/AIAgent/utils/agentSessionEvents';
import {
    addAgentCommands,
    addAgentFunctions,
    createAgentChatFile,
    openAgentNeovim,
    setupAgentKeyBindings,
} from '@/AI/AIAgent/main/agentNeovimSetup';
import { getErrorMessage, setupEventHandlers } from '@/AI/AIAgent/main/agentPromptActions';



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
    const session = await options.client.createSession({
        clientName: 'copilot-cli',
        model: options.model,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        workingDirectory: proposalWorkspace.workspacePath,
        streaming: true,
        enableConfigDiscovery: true,
        skillDirectories: [path.join(__dirname, '..', '..', '..', 'skills')],
        mcpServers,
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob'],
        onPermissionRequest: () => ({ kind: 'approved' }),
        infiniteSessions: {
            enabled: true,
            backgroundCompactionThreshold: 0.70,
            bufferExhaustionThreshold: 0.90,
        },
        hooks: {
            onPreToolUse: async (input) => {
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
            onPostToolUse: async (input) => {
                // Bash/shell output: errors and summaries land at the tail, so bias
                // toward keeping more of the end.  All other tools use a 50/50 split.
                const isBashLike = ['bash', 'shell', 'execute', 'run_terminal', 'computer'].some(
                    (fragment) => input.toolName.toLowerCase().includes(fragment)
                );
                const HEAD_CHARS = isBashLike ? 2000 : 4000;
                const TAIL_CHARS = isBashLike ? 6000 : 4000;
                const text = input.toolResult.textResultForLlm;
                if (text.length <= HEAD_CHARS + TAIL_CHARS) return;
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
            onUserPromptSubmitted: async () => ({
                additionalContext: 'REMINDER: Call confirm_task_complete before ending your turn — whether you are done, need clarification, or want to ask the user anything.',
            }),
        },

        onUserInputRequest: async (request) => handleAgentUserInput(
            nvimClient,
            request.question,
            request.choices,
            request.allowFreeform ?? true
        ),

        systemMessage: {
            mode: 'append',
            content: `${aiRoles[options.role]}

<turn_completion priority="critical">
End every turn by calling \`confirm_task_complete\` with a concise summary and 2–4 concrete choices. This applies whether you finished, are blocked, need clarification, or are unsure what to do next. Never end a turn with plain text or without calling \`confirm_task_complete\` — the user relies on this signal to know when you are done and to respond appropriately.
</turn_completion>

<workspace>
You are in a detached proposal workspace. Edits land in the real repository only after the user reviews the resulting git diff in Neovim, so edit files freely.
</workspace>

<tool_usage>
Default workflow: search → outline → read_lines → edit_lines. Run independent calls in parallel.

Searching — \`kra-file-context:search\` (replaces grep/glob, both disabled).
Use \`name_pattern\` (glob) to find files, \`content_pattern\` (regex) to grep contents, or both together to intersect. Every result is annotated \`path (N lines)\` so you can decide read-whole vs outline up front.

Reading code
  - Files ≤150 lines: read whole with \`read_lines\`.
  - Files >150 lines: call \`get_outline\` FIRST, then \`read_lines\` on the exact range, or \`read_function\` if you know the symbol. Never guess ranges — speculative reads (e.g. "first 100 + last 100") waste the same tokens you were trying to save.

Reading data files (JSON/YAML/TOML/MD/.env/logs)
\`get_outline\` still returns the line count even with no symbols; use it to size a small \`read_lines\` window. The built-in \`view\` / \`read_file\` tools are disabled.

Editing
Required workflow: \`get_outline\` → \`read_lines\` on the exact target range → \`edit_lines\`. For multiple small changes to one file, make multiple targeted \`edit_lines\` calls — one per section. Never rewrite a file you only partially read; you will destroy content you never saw. Always edit with the smallest possible range, never the whole file.

Creating new files: use \`create_file\`.
</tool_usage>

Reminder: end every turn with \`confirm_task_complete\`.`,
        },
    });

    const state: AgentConversationState = {
        chatFile,
        model: options.model,
        role: options.role,
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
        const runCleanup = () => {
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
