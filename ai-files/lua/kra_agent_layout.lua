local layout = require('kra_prompt_layout').create({
    namespace = 'kra_agent',
    prompt_buffer_name = 'kra-agent-prompt',
    prompt_winbar = ' 󰍩 USER PROMPT ',
    prompt_statusline = ' USER PROMPT ',
    transcript_winbar = ' 󰭻 CONVERSATION ',
    transcript_statusline = ' AGENT ',
    setup_transcript_buffer = function(transcript_buf)
        -- AgentReasoning highlight: every line starting with '>' is the
        -- model's chain-of-thought. Was previously a `:syntax match` rule,
        -- but vim's classic regex syntax engine retains per-line state
        -- tables that grow without bound as the transcript appends —
        -- a long thinking section drove nvim to multi-GB RSS. Extmarks
        -- are O(changed range) per update and don't leak across appends.
        vim.api.nvim_set_hl(0, 'AgentReasoning', { fg = '#61AFEF' })
        local ns = vim.api.nvim_create_namespace('kra_agent_reasoning')

        local function highlight_line(buf, lnum)
            local ok, lines = pcall(vim.api.nvim_buf_get_lines, buf, lnum, lnum + 1, false)
            if not ok or not lines or not lines[1] then return end
            if lines[1]:sub(1, 1) == '>' then
                pcall(vim.api.nvim_buf_set_extmark, buf, ns, lnum, 0, {
                    end_row = lnum,
                    end_col = #lines[1],
                    hl_group = 'AgentReasoning',
                })
            end
        end

        local function rescan_range(buf, first, last)
            pcall(vim.api.nvim_buf_clear_namespace, buf, ns, first, last)
            for i = first, last - 1 do
                highlight_line(buf, i)
            end
        end

        local function rescan_all(buf)
            if not vim.api.nvim_buf_is_valid(buf) then return end
            local n = vim.api.nvim_buf_line_count(buf)
            rescan_range(buf, 0, n)
        end

        rescan_all(transcript_buf)

        vim.api.nvim_buf_attach(transcript_buf, false, {
            on_lines = function(_, buf, _, first_line, _last_line_old, last_line_new)
                if not vim.api.nvim_buf_is_valid(buf) then return true end
                vim.schedule(function()
                    rescan_range(buf, first_line, last_line_new)
                end)
            end,
        })

        vim.api.nvim_create_autocmd('BufReadPost', {
            buffer = transcript_buf,
            callback = function()
                rescan_all(transcript_buf)
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
