import * as fs from 'fs/promises';
import * as neovim from 'neovim';
import { formatAgentDraftEntry } from '@/AI/AIAgent/shared/utils/agentUi';
import { buildAgentTmuxCommand } from '@/AI/AIAgent/shared/utils/agentTmux';
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as aiNeovimHelper from '@/AI/shared/utils/conversationUtils/aiNeovimHelper';

export async function createAgentChatFile(chatFile: string): Promise<void> {
    const initialContent = `# Copilot Agent Chat

            This session runs the Copilot SDK against a proposal workspace. Proposed edits are reviewed in Neovim before they are applied to the repository.

            # Controls / Shortcuts:
            #   Enter        -> Submit prompt
            #   Ctrl+c       -> Stop current agent turn
            #   @            -> Add file context(s) (<Tab> multi-select, + marks selections, <CR> confirm, <Esc> cancel)
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
            #   <leader>m    -> Browse kra-memory (<Tab> view, a add, dd del; <CR> opens entry buffer: <leader>w save / d del / r resolve / x dismiss / q close)
            #   <leader>i    -> Reopen the kra-memory index-progress modal
            #   <leader>?    -> Show all keymaps
            ${formatAgentDraftEntry().trimStart()}`;

    await fs.writeFile(chatFile, initialContent, 'utf8');
}

export async function addAgentCommands(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.command(`command! -nargs=0 ReviewProposal call ReviewProposal()`);
    await nvimClient.command(`command! -nargs=0 OpenProposalFile call OpenProposalFile()`);
    await nvimClient.command(`command! -nargs=0 ApplyProposal call ApplyProposal()`);
    await nvimClient.command(`command! -nargs=0 RejectProposal call RejectProposal()`);
    await nvimClient.command(`command! -nargs=0 AgentToolHistory lua require('kra_agent_ui').show_history()`);
    await nvimClient.command(`command! -nargs=0 AgentCommands lua require('which-key').show({ global = false })`);
}

export async function addAgentFunctions(nvimClient: neovim.NeovimClient, channelId: number): Promise<void> {
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

export async function setupAgentKeyBindings(nvimClient: neovim.NeovimClient): Promise<void> {
    const channelId = await nvimClient.channelId;
    await nvimClient.executeLua(`
        local map = vim.keymap.set
        local opts = { buffer = 0, silent = true }
        map('n', '<leader>d', '<Cmd>call ReviewProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Review proposal diff' }))
        map('n', '<leader>o', '<Cmd>call OpenProposalFile()<CR>', vim.tbl_extend('force', opts, { desc = 'Open proposal file' }))
        map('n', '<leader>a', '<Cmd>call ApplyProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Apply proposal changes' }))
        map('n', '<leader>r', '<Cmd>call RejectProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Reject proposal changes' }))
        map('n', '<leader>h', '<Cmd>AgentToolHistory<CR>', vim.tbl_extend('force', opts, { desc = 'Show tool history' }))
        map('n', '<leader>y', function() vim.fn.rpcnotify(${channelId}, 'prompt_action', 'toggle_yolo_mode') end, vim.tbl_extend('force', opts, { desc = 'Toggle YOLO approvals' }))
        map('n', '<leader>P', function() vim.fn.rpcnotify(${channelId}, 'prompt_action', 'reset_tool_approvals') end, vim.tbl_extend('force', opts, { desc = 'Reset remembered approvals' }))
        map('n', '<leader>?', '<Cmd>AgentCommands<CR>', vim.tbl_extend('force', opts, { desc = 'Show agent commands' }))
        map('n', '<leader>s', function() require('kra_agent_ui').show_diff_history() end, vim.tbl_extend('force', opts, { desc = 'Session diff history' }))
        map('n', '<leader>m', function() vim.fn.rpcnotify(${channelId}, 'prompt_action', 'browse_memory') end, vim.tbl_extend('force', opts, { desc = 'Browse kra-memory' }))
        map('n', '<leader>i', function() require('kra_agent_ui').reopen_index_progress() end, vim.tbl_extend('force', opts, { desc = 'Reopen kra-memory index progress' }))
        vim.g.kra_agent_channel = ${channelId}

        -- Highlight reasoning lines (> prefix) in blue, independent of theme.
        vim.api.nvim_set_hl(0, 'AgentReasoning', { fg = '#61AFEF' })
        vim.cmd('syntax match AgentReasoning /^>.*/')
        -- Reapply after every :edit! reload so the highlight survives nvimRefresh calls.
        vim.api.nvim_create_autocmd('BufReadPost', {
            buffer = 0,
            callback = function()
                vim.cmd('syntax match AgentReasoning /^>.*/')
            end,
        })
    `, []);
}



export async function openAgentNeovim(chatFile: string): Promise<neovim.NeovimClient> {
    const socketPath = await aiNeovimHelper.generateSocketPath();

    if (process.env.TMUX) {
        await bash.execCommand(buildAgentTmuxCommand(chatFile, socketPath));
    } else {
        void openVim(chatFile, '-u', neovimConfig, '--listen', socketPath);
    }

    await aiNeovimHelper.waitForSocket(socketPath);

    return neovim.attach({ socket: socketPath });
}
