local layout = require('kra_prompt_layout').create({
    namespace = 'kra_agent',
    prompt_buffer_name = 'kra-agent-prompt',
    prompt_winbar = ' 󰍩 USER PROMPT ',
    prompt_statusline = ' USER PROMPT ',
    transcript_winbar = ' 󰭻 CONVERSATION ',
    transcript_statusline = ' AGENT ',
    setup_transcript_buffer = function(transcript_buf)
        vim.api.nvim_set_hl(0, 'AgentReasoning', { fg = '#61AFEF' })
        vim.api.nvim_buf_call(transcript_buf, function()
            vim.cmd('syntax match AgentReasoning /^>.*/')
        end)
        vim.api.nvim_create_autocmd('BufReadPost', {
            buffer = transcript_buf,
            callback = function()
                vim.cmd('syntax match AgentReasoning /^>.*/')
            end,
        })
    end,
    extend_keymaps = function(buf, channel_id)
        local map = vim.keymap.set
        local opts = { buffer = buf, silent = true }

        map('n', '<leader>d', '<Cmd>call ReviewProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Review proposal diff' }))
        map('n', '<leader>o', '<Cmd>call OpenProposalFile()<CR>', vim.tbl_extend('force', opts, { desc = 'Open proposal file' }))
        map('n', '<leader>a', '<Cmd>call ApplyProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Apply proposal changes' }))
        map('n', '<leader>r', '<Cmd>call RejectProposal()<CR>', vim.tbl_extend('force', opts, { desc = 'Reject proposal changes' }))
        map('n', '<leader>h', '<Cmd>AgentToolHistory<CR>', vim.tbl_extend('force', opts, { desc = 'Show tool history' }))
        map('n', '<leader>y', function()
            vim.fn.rpcnotify(channel_id, 'prompt_action', 'toggle_yolo_mode')
        end, vim.tbl_extend('force', opts, { desc = 'Toggle YOLO approvals' }))
        map('n', '<leader>P', function()
            vim.fn.rpcnotify(channel_id, 'prompt_action', 'reset_tool_approvals')
        end, vim.tbl_extend('force', opts, { desc = 'Reset remembered approvals' }))
        map('n', '<leader>?', '<Cmd>AgentCommands<CR>', vim.tbl_extend('force', opts, { desc = 'Show agent commands' }))
        map('n', '<leader>s', function()
            require('kra_agent.ui').show_diff_history()
        end, vim.tbl_extend('force', opts, { desc = 'Session diff history' }))
        map('n', '<leader>m', function()
            vim.fn.rpcnotify(channel_id, 'prompt_action', 'browse_memory')
        end, vim.tbl_extend('force', opts, { desc = 'Browse kra-memory' }))
        map('n', '<leader>i', function()
            require('kra_agent.ui').reopen_index_progress()
        end, vim.tbl_extend('force', opts, { desc = 'Reopen kra-memory index progress' }))
    end,
})

return layout
