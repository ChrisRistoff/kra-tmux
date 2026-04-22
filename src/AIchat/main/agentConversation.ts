import * as fs from 'fs/promises';
import path from 'path';
import * as neovim from 'neovim';
import { type MessageOptions } from '@github/copilot-sdk';

import { aiRoles } from '@/AIchat/data/roles';
import { getConfiguredMcpServers } from '@/AIchat/utils/agentSettings';
import { buildAgentTmuxCommand } from '@/AIchat/utils/agentTmux';
import {
    extractAgentDraftPrompt,
    formatAgentConversationEntry,
    formatAgentDraftEntry,
    isAgentDraftHeader,
    isAgentUserHeader,
    materializeAgentDraft,
} from '@/AIchat/utils/agentUi';
import {
    createProposalWorkspace,
    hasProposalChanges,
    removeProposalWorkspace,
} from '@/AIchat/utils/proposalWorkspace';
import type { FileContext } from '@/AIchat/types/aiTypes';
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as aiNeovimHelper from '@/AIchat/utils/conversationUtils/aiNeovimHelper';
import * as fileContext from '@/AIchat/utils/conversationUtils/fileContexts';
import type { AgentConversationOptions, AgentConversationState } from '@/AIchat/types/agentTypes';
import { appendToChat, handleAgentUserInput, handlePreToolUse } from '@/AIchat/utils/agentToolHook';
import {
    applyProposal,
    openChangedProposalFile,
    rejectCurrentProposal,
    setupSessionEventHandlers,
    showProposalReview,
    updateAgentUi,
} from '@/AIchat/utils/agentSessionEvents';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error';
}

function extractCurrentUserPrompt(lines: string[]): string {
    const draftPrompt = extractAgentDraftPrompt(lines);

    if (draftPrompt) {
        return draftPrompt;
    }

    let startIndex = -1;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isAgentUserHeader(lines[index])) {
            startIndex = index + 1;
            break;
        }
    }

    if (startIndex === -1) {
        return '';
    }

    return lines.slice(startIndex).join('\n').trim();
}

async function buildAttachments(): Promise<NonNullable<MessageOptions['attachments']>> {
    const attachments: NonNullable<MessageOptions['attachments']> = [];

    for (const context of fileContext.fileContexts) {
        const displayName = context.filePath.split('/').pop() || context.filePath;

        if (!context.isPartial) {
            attachments.push({
                type: 'file',
                path: context.filePath,
                displayName,
            });
            continue;
        }

        attachments.push(await createSelectionAttachment(context, displayName));
    }

    return attachments;
}

async function createSelectionAttachment(
    context: FileContext,
    displayName: string
): Promise<{
    type: 'selection',
    filePath: string,
    displayName: string,
    selection: {
        start: { line: number, character: number },
        end: { line: number, character: number },
    },
    text: string,
}> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const allLines = content.split('\n');
    const startLine = context.startLine || 1;
    const endLine = context.endLine || startLine;
    const selectedText = allLines.slice(startLine - 1, endLine).join('\n');

    return {
        type: 'selection',
        filePath: context.filePath,
        displayName,
        selection: {
            start: { line: startLine - 1, character: 0 },
            end: { line: endLine - 1, character: allLines[endLine - 1]?.length || 0 },
        },
        text: selectedText,
    };
}

async function createAgentChatFile(chatFile: string): Promise<void> {
    const initialContent = `# Copilot Agent Chat

            This session runs the Copilot SDK against a proposal workspace. Proposed edits are reviewed in Neovim before they are applied to the repository.

            # Controls / Shortcuts:
            #   Enter        -> Submit prompt
            #   Ctrl+c       -> Stop current agent turn
            #   @            -> Add file context
            #   r            -> Remove file from context
            #   f            -> Show active file contexts
            #   Ctrl+x       -> Clear all contexts
            #   <leader>t    -> Toggle popups for tools and agent current actions on/off
            #
            # Proposal controls (shown automatically after each turn with changes):
            #   <leader>o    -> Open a changed proposal file
            #   <leader>a    -> Apply proposal to the repository
            #   <leader>r    -> Reject proposal
            #
            # Agent controls:
            #   <leader>y    -> Toggle YOLO mode (auto-approve all tools)
            #   <leader>P    -> Reset remembered tool approvals
            #   <leader>h    -> Browse recent tool calls
            #   <leader>s    -> Browse session diff history (all AI write diffs)
            #   <leader>?    -> Show all keymaps
            ${formatAgentDraftEntry().trimStart()}`;

    await fs.writeFile(chatFile, initialContent, 'utf8');
}

async function handleSubmit(state: AgentConversationState): Promise<void> {
    if (state.isStreaming) {
        await state.nvim.command('echohl WarningMsg | echo "Agent is still responding" | echohl None');
        return;
    }

    const buffer = await state.nvim.buffer;
    const lines = await buffer.lines;
    const prompt = extractCurrentUserPrompt(lines);

    if (!prompt) {
        await state.nvim.command('echohl WarningMsg | echo "Type a prompt before submitting" | echohl None');
        return;
    }

    if (lines.some((line) => isAgentDraftHeader(line))) {
        await fs.writeFile(state.chatFile, materializeAgentDraft(lines), 'utf8');
        await state.nvim.command('edit!');
    }

    state.isStreaming = true;
    await updateAgentUi(state.nvim, 'start_turn', [state.model]);
    await appendToChat(state.chatFile, formatAgentConversationEntry('ASSISTANT', { model: state.model }));
    await aiNeovimHelper.updateNvimAndGoToLastLine(state.nvim);

    const attachments = await buildAttachments();

    await state.session.send({
        prompt,
        attachments,
        mode: 'immediate',
    });
}

async function addAgentCommands(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.command(`command! -nargs=0 ReviewProposal call ReviewProposal()`);
    await nvimClient.command(`command! -nargs=0 OpenProposalFile call OpenProposalFile()`);
    await nvimClient.command(`command! -nargs=0 ApplyProposal call ApplyProposal()`);
    await nvimClient.command(`command! -nargs=0 RejectProposal call RejectProposal()`);
    await nvimClient.command(`command! -nargs=0 AgentToolHistory lua require('kra_agent_ui').show_history()`);
    await nvimClient.command(`command! -nargs=0 AgentCommands lua require('which-key').show({ global = false })`);
}

async function addAgentFunctions(nvimClient: neovim.NeovimClient, channelId: number): Promise<void> {
    await nvimClient.command(`
        function! ReviewProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'review_proposal')
        endfunction
    `);

    await nvimClient.command(`
        function! OpenProposalFile()
            call rpcnotify(${channelId}, 'prompt_action', 'open_proposal_file')
        endfunction
    `);

    await nvimClient.command(`
        function! ApplyProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'apply_proposal')
        endfunction
    `);

    await nvimClient.command(`
        function! RejectProposal()
            call rpcnotify(${channelId}, 'prompt_action', 'reject_proposal')
        endfunction
    `);
}

async function setupAgentKeyBindings(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.executeLua(`
        local map = vim.keymap.set
        local opts = { buffer = 0, silent = true }
        map('n', '<leader>d', '<Cmd>call ReviewProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Review proposal diff' }))
        map('n', '<leader>o', '<Cmd>call OpenProposalFile()<CR>', vim.tbl_extend('force', opts, { desc = 'Open proposal file' }))
        map('n', '<leader>a', '<Cmd>call ApplyProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Apply proposal changes' }))
        map('n', '<leader>r', '<Cmd>call RejectProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Reject proposal changes' }))
        map('n', '<leader>h', '<Cmd>AgentToolHistory<CR>', vim.tbl_extend('force', opts, { desc = 'Show tool history' }))
        map('n', '<leader>y', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'toggle_yolo_mode') end, vim.tbl_extend('force', opts, { desc = 'Toggle YOLO approvals' }))
        map('n', '<leader>P', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'reset_tool_approvals') end, vim.tbl_extend('force', opts, { desc = 'Reset remembered approvals' }))
        map('n', '<leader>?', '<Cmd>AgentCommands<CR>', vim.tbl_extend('force', opts, { desc = 'Show agent commands' }))
        map('n', '<leader>s', function() require('kra_agent_ui').show_diff_history() end, vim.tbl_extend('force', opts, { desc = 'Session diff history' }))
    `, []);
}

async function setupEventHandlers(state: AgentConversationState): Promise<void> {
    state.nvim.on('notification', async (method, args) => {
        if (method !== 'prompt_action') {
            return;
        }

        const action = args[0] as string;

        try {
            switch (action) {
                case 'submit_pressed':
                    await handleSubmit(state);
                    break;
                case 'add_file_context':
                    await fileContext.handleAddFileContext(state.nvim, state.chatFile, { agentMode: true });
                    break;
                case 'stop_stream':
                    await state.session.abort();
                    state.isStreaming = false;
                    await updateAgentUi(state.nvim, 'stop_turn', ['Stopped current agent turn']);
                    break;
                case 'show_contexts_popup':
                    await fileContext.showFileContextsPopup(state.nvim);
                    break;
                case 'remove_file_context':
                    await fileContext.handleRemoveFileContext(state.nvim);
                    break;
                case 'clear_contexts':
                    await fileContext.clearAllFileContexts(state.nvim);
                    break;
                case 'review_proposal':
                    await showProposalReview(state.nvim, state);
                    break;
                case 'open_proposal_file':
                    await openChangedProposalFile(state);
                    break;
                case 'apply_proposal':
                    await applyProposal(state);
                    break;
                case 'reject_proposal':
                    await rejectCurrentProposal(state);
                    break;
                case 'toggle_yolo_mode':
                    state.approvalMode = state.approvalMode === 'yolo' ? 'strict' : 'yolo';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(
                        state.nvim,
                        'show_error',
                        ['Approval mode', state.approvalMode === 'yolo' ? 'YOLO mode enabled.' : 'Strict approval mode enabled.']
                    );
                    break;
                case 'reset_tool_approvals':
                    state.approvalMode = 'strict';
                    state.allowedToolFamilies.clear();
                    await updateAgentUi(state.nvim, 'show_error', ['Approval mode', 'Reset remembered approvals.']);
                    break;
                default:
                    console.log('Unknown action:', action);
            }
        } catch (error) {
            await updateAgentUi(state.nvim, 'show_error', [
                `Action failed: ${action}`,
                getErrorMessage(error),
            ]);
        }
    });
}

async function openAgentNeovim(chatFile: string): Promise<neovim.NeovimClient> {
    const socketPath = await aiNeovimHelper.generateSocketPath();

    if (process.env.TMUX) {
        await bash.execCommand(buildAgentTmuxCommand(chatFile, socketPath));
    } else {
        void openVim(chatFile, '-u', neovimConfig, '--listen', socketPath);
    }

    await aiNeovimHelper.waitForSocket(socketPath);

    return neovim.attach({ socket: socketPath });
}

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
            tools: ['get_outline', 'read_lines', 'read_function', 'edit_lines', 'create_file'],
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
        excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit'],
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

            You are working inside a detached proposal workspace. Edit files there freely — the real repository is only updated after the user reviews and applies the resulting git diff from Neovim.

            TOOL USAGE - BE SURGICAL:
            - Editing: Always prefer kra-file-context:edit_lines over any built-in edit tool. Line-range edits are precise and never fail due to stale old_str context. Workflow: get_outline → read_lines to confirm the target lines → edit_lines to replace them. To read multiple ranges in one call, pass startLines and endLines arrays. To apply multiple edits in one call, pass startLines, endLines, and newContents arrays (line numbers refer to the original file; edits are applied bottom-to-top internally).
            - Creating new files: use kra-file-context:create_file(file_path, content).

            CRITICAL RULE - ALWAYS call the confirm_task_complete tool before ending your turn.
            This applies in every situation:
            - When you think all tasks are done.
            - When you need clarification or more information from the user.
            - When you want to ask a follow-up question or present options.
            - When you are unsure what to do next.

            NEVER end your turn with plain text. ALWAYS call confirm_task_complete instead.
            Pass a concise summary and 2–4 concrete choices so the user can guide you.
            Their reply will be returned to you so you can continue without costing extra credits.`,
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
