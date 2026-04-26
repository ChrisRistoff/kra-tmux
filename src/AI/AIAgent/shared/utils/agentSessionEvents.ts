import * as neovim from 'neovim';
import type { VimValue } from 'neovim/lib/types/VimValue';
import {
    formatAgentDraftEntry,
    formatToolArguments,
    formatToolCompletion,
    formatToolDisplayName,
    formatToolLine,
    formatToolProgress,
    summarizeToolCall,
} from '@/AI/AIAgent/shared/utils/agentUi';
import * as bash from '@/utils/bashHelper';
import * as aiNeovimHelper from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';
import { appendToChat } from '@/AI/AIAgent/shared/utils/agentToolHook';
import type { AgentConversationState } from '@/AI/AIAgent/shared/types/agentTypes';
import { setupQuotaTracking } from '@/AI/AIAgent/shared/utils/agentQuotaTracker';

function quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function listProposalChanges(cwd: string): Promise<string[]> {
    const [modified, untracked] = await Promise.all([
        bash.execCommand(`git -C ${quote(cwd)} diff --name-only HEAD`)
            .then(r => r.stdout.trim().split('\n').filter(Boolean)),
        bash.execCommand(`git -C ${quote(cwd)} ls-files --others --exclude-standard`)
            .then(r => r.stdout.trim().split('\n').filter(Boolean)),
    ]);

    return [...new Set([...modified, ...untracked])];
}

async function readProposalDiff(cwd: string): Promise<string> {
    const savedTree = (await bash.execCommand(`git -C ${quote(cwd)} write-tree`)).stdout.trim();
    try {
        await bash.execCommand(`git -C ${quote(cwd)} add -A`);
        const result = await bash.execCommand(`git --no-pager -C ${quote(cwd)} diff --cached HEAD`);

        return result.stdout;
    } finally {
        await bash.execCommand(`git -C ${quote(cwd)} read-tree ${quote(savedTree)}`);
    }
}

function escapeForSingleQuotes(s: string): string {
    return s.replace(/'/g, `'\\''`);
}

function escapeForVimPath(s: string): string {
    return s.replace(/[\\% #]/g, '\\$&');
}

export async function updateAgentUi(
    nvimClient: neovim.NeovimClient,
    method: string,
    args: unknown[] = []
): Promise<void> {
    try {
        await nvimClient.executeLua(`require('kra_agent_ui').${method}(...)`, args as VimValue[]);
    } catch {
        // Ignore UI update failures during startup/shutdown so the session itself can continue.
    }
}

export async function showProposalReview(nvimClient: neovim.NeovimClient, state: AgentConversationState): Promise<void> {
    await state.nvim.command('silent! wall');
    const diff = await readProposalDiff(state.cwd);

    if (!diff.trim()) {
        await nvimClient.command('echohl WarningMsg | echo "No proposal changes to review" | echohl None');

        return;
    }

    const lines = [
        '# Proposal review',
        '# a: apply  r: reject  o: open changed file  R: refresh  q: close',
        '',
        ...diff.split('\n'),
    ];

    await nvimClient.executeLua(`
        local content = ...
        local buf = vim.api.nvim_create_buf(false, true)
        vim.cmd('tabnew')
        vim.api.nvim_win_set_buf(0, buf)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, content)
        vim.api.nvim_buf_set_name(buf, 'kra-agent-review.diff')
        vim.bo[buf].buftype = 'nofile'
        vim.bo[buf].bufhidden = 'wipe'
        vim.bo[buf].swapfile = false
        vim.bo[buf].filetype = 'diff'
        vim.keymap.set('n', 'q', function() vim.cmd('close') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'a', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'apply_proposal') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'r', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'reject_proposal') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'o', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'open_proposal_file') end, { buffer = buf, silent = true })
        vim.keymap.set('n', 'R', function() vim.fn.rpcnotify(${await nvimClient.channelId}, 'prompt_action', 'review_proposal') end, { buffer = buf, silent = true })
    `, [lines]);
}

async function selectChangedProposalFile(
    nvimClient: neovim.NeovimClient,
    proposalFiles: string[]
): Promise<string | null> {
    const channelId = await nvimClient.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'proposal_file_selected') {
                return;
            }

            nvimClient.removeListener('notification', handler);
            resolve((args[0] as string) || null);
        };

        nvimClient.on('notification', handler);
        nvimClient.executeLua(`
            local files = ...
            local actions = require('telescope.actions')
            local action_state = require('telescope.actions.state')

            require('telescope.pickers').new({}, {
                prompt_title = 'Open proposal file',
                finder = require('telescope.finders').new_table(files),
                sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local selection = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'proposal_file_selected', selection and (selection.value or selection[1]) or nil)
                    end)

                    map('i', '<Esc>', function()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'proposal_file_selected', nil)
                    end)

                    return true
                end
            }):find()
        `, [proposalFiles]).catch(() => {
            nvimClient.removeListener('notification', handler);
            resolve(null);
        });
    });
}

export async function openChangedProposalFile(state: AgentConversationState): Promise<void> {
    await state.nvim.command('silent! wall');
    const changedFiles = await listProposalChanges(state.cwd);

    if (!changedFiles.length) {
        await state.nvim.command('echohl WarningMsg | echo "No changed proposal files" | echohl None');

        return;
    }

    const selectedFile = await selectChangedProposalFile(state.nvim, changedFiles);

    if (!selectedFile) {
        await state.nvim.command('echohl WarningMsg | echo "No proposal file selected" | echohl None');

        return;
    }

    await state.nvim.command(`tabedit ${escapeForVimPath(`${state.cwd}/${selectedFile}`)}`);
}

export async function applyProposal(state: AgentConversationState): Promise<void> {
    await state.nvim.command('silent! wall');
    const message = 'Changes are already written to the repository.';
    await state.nvim.command(`echohl MoreMsg | echo '${escapeForSingleQuotes(message)}' | echohl None`);
}

export async function rejectCurrentProposal(state: AgentConversationState): Promise<void> {
    await state.history.revertAll(state.nvim);
    await state.nvim.command('echohl WarningMsg | echo "Rejected current proposal changes" | echohl None');
}

export async function setupSessionEventHandlers(state: AgentConversationState): Promise<void> {
    const FLUSH_INTERVAL_MS = 50;

    let pendingBuffer = '';
    let activeToolCount = 0;
    let currentToolLabel = 'tool';
    let assistantStatusVisible = true;
    let firstToolThisTurn = true;
    let reasoningStarted = false;
    const toolLabels = new Map<string, string>();
    const toolStartLabels = new Map<string, string>();

    // Serialised write chain — all disk writes queue here so order is guaranteed
    // and concurrent writes cannot corrupt the file.
    let writeChain = Promise.resolve();

    const enqueue = (fn: () => Promise<void>): void => {
        writeChain = writeChain.then(fn).catch(() => { /* swallow */ });
    };

    const nvimRefresh = async (): Promise<void> =>
        state.nvim.command('edit!')
            .then(async () => state.nvim.command('redraw!'))
            .catch(() => { /* neovim busy — skip */ });

    // Write text to the chat file and refresh neovim (through the queue).
    const write = (content: string, refresh = true): void => {
        enqueue(async () => {
            await appendToChat(state.chatFile, content);
            if (refresh) {
                await nvimRefresh();
            }
        });
    };

    // Drain the pending AI text buffer (called before each tool and at idle).
    const flushBuffer = (): void => {
        if (!pendingBuffer) {
            return;
        }

        const text = pendingBuffer;
        pendingBuffer = '';
        write(text);
    };

    // Flush AI text every FLUSH_INTERVAL_MS so streaming is visible.
    // Uses a self-scheduling setTimeout rather than setInterval so the timer
    // goes completely dormant when there is nothing to flush (e.g. while the
    // agent is paused waiting for user input). An active setInterval keeps the
    // event loop alive and prevents V8 from running a full GC cycle.
    let flushTimerHandle: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = (): void => {
        if (flushTimerHandle !== null) return;
        flushTimerHandle = setTimeout(() => {
            flushTimerHandle = null;
            if (pendingBuffer && activeToolCount === 0) {
                flushBuffer();
            }
            // Keep rescheduling only while there is content waiting.
            if (pendingBuffer) {
                scheduleFlush();
            }
        }, FLUSH_INTERVAL_MS);
    };

    const clearFlushTimer = (): void => {
        if (flushTimerHandle !== null) {
            clearTimeout(flushTimerHandle);
            flushTimerHandle = null;
        }
    };

    // ============================================================================
    // REASONING & CONTENT STREAMING
    // ============================================================================

    state.session.on('assistant.reasoning_delta', (event) => {
        const isFirst = !reasoningStarted;
        reasoningStarted = true;
        enqueue(async () => {
            // Replace newlines so continuation lines stay inside the blockquote.
            // Only the very first delta gets the opening '> 💭 ' prefix.
            const content = event.data.deltaContent.replace(/\n/g, '\n> ');
            const prefix = isFirst ? '> 💭 ' : '';
            await appendToChat(state.chatFile, `${prefix}${content}`);
            await nvimRefresh();
        });
    });


    state.session.on('assistant.message_delta', (event) => {
        if (reasoningStarted) {
            // Reasoning just ended — close the blockquote with a blank line
            enqueue(async () => {
                await appendToChat(state.chatFile, '\n\n');
                await nvimRefresh();
            });
            reasoningStarted = false;
        }

        pendingBuffer += event.data.deltaContent;
        scheduleFlush();

        if (activeToolCount === 0 && !assistantStatusVisible) {
            assistantStatusVisible = true;
            void updateAgentUi(state.nvim, 'start_turn', [state.model]);
        }
    });

    // ============================================================================
    // TOOL EXECUTION HANDLERS
    // ============================================================================

    state.session.on('tool.execution_start', (event) => {
        activeToolCount += 1;
        const toolName = formatToolDisplayName(
            event.data.toolName,
            event.data.mcpServerName,
            event.data.mcpToolName
        );
        currentToolLabel = toolName;
        assistantStatusVisible = false;
        toolLabels.set(event.data.toolCallId, toolName);
        toolStartLabels.set(event.data.toolCallId, summarizeToolCall(toolName, event.data.arguments));

        // Flush any buffered AI text before the first tool of this group.
        if (firstToolThisTurn) {
            firstToolThisTurn = false;
            flushBuffer();
        }

        const details = `Running ${toolName}\n\nArguments:\n${formatToolArguments(event.data.arguments)}`;
        const argsJson = JSON.stringify(event.data.arguments, null, 2);
        void updateAgentUi(state.nvim, 'start_tool', [toolName, details, argsJson]);
    });

    state.session.on('tool.execution_progress', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const details = `Running tool\n\n${formatToolProgress(event.data.progressMessage)}`;
        void updateAgentUi(state.nvim, 'update_tool', [currentToolLabel, details]);
    });

    state.session.on('tool.execution_partial_result', (event) => {
        currentToolLabel = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const details = `Streaming tool output\n\n${formatToolProgress(event.data.partialOutput)}`;
        void updateAgentUi(state.nvim, 'update_tool', [currentToolLabel, details]);
    });

    state.session.on('tool.execution_complete', (event) => {
        activeToolCount = Math.max(0, activeToolCount - 1);
        const toolName = toolLabels.get(event.data.toolCallId) ?? currentToolLabel;
        const toolSummary = toolStartLabels.get(event.data.toolCallId) ?? toolName;
        toolLabels.delete(event.data.toolCallId);
        toolStartLabels.delete(event.data.toolCallId);
        currentToolLabel = toolName;
        assistantStatusVisible = activeToolCount === 0;

        // After all tools finish, re-enable timer so next AI text is flushed.
        if (activeToolCount === 0) {
            firstToolThisTurn = true;
            reasoningStarted = false;
        }

        write(formatToolLine(toolSummary, event.data.success));

        const details = formatToolCompletion(event.data.success, event.data.result, event.data.error);
        void updateAgentUi(state.nvim, 'complete_tool', [
            toolName,
            details,
            event.data.success,
        ]);

        // Notify the diff module so any pending diff entry queued by an approved
        // (possibly user-edited) write tool is either committed to the diff
        // history (success) or discarded (failure / intercepted deny). Tools
        // that never opened a diff editor have no pending entry, so this is a
        // no-op for them.
        state.nvim
            .executeLua(
                `require('kra_agent_diff').finalize_pending_diff(...)`,
                [event.data.success] as VimValue[]
            )
            .catch(() => { /* swallow */ });
    });

    // ============================================================================
    // SESSION STATE
    // ============================================================================

    state.session.on('session.idle', () => {
        void (async () => {
            clearFlushTimer();
            flushBuffer();

            // Wait for all in-flight writes to finish before appending the draft.
            await writeChain;

            activeToolCount = 0;
            assistantStatusVisible = false;
            state.isStreaming = false;

            await appendToChat(state.chatFile, formatAgentDraftEntry());
            await nvimRefresh();
            await updateAgentUi(state.nvim, 'ready_for_next_prompt');
            await aiNeovimHelper.updateNvimAndGoToLastLine(state.nvim);

        })();
    });

    setupQuotaTracking(state);
}
