local M = {}

function M.create(config)
    local function state_key(name)
        return config.namespace .. '_' .. name
    end

    local function get_state(name)
        return vim.g[state_key(name)]
    end

    local function set_state(name, value)
        vim.g[state_key(name)] = value
    end

    local function is_valid_win(win)
        return type(win) == 'number' and vim.api.nvim_win_is_valid(win)
    end

    local function is_valid_buf(buf)
        return type(buf) == 'number' and vim.api.nvim_buf_is_valid(buf)
    end

    local function mark_buffer(buf)
        vim.bo[buf].buflisted = false
        vim.b[buf].kra_agent_hide_filename = true
    end

    local function with_autohide_suppressed(callback)
        local suppress_key = state_key('suppress_prompt_autohide')
        local previous = vim.g[suppress_key]
        vim.g[suppress_key] = true

        local ok, result = pcall(callback)

        vim.g[suppress_key] = previous

        if not ok then
            error(result)
        end

        return result
    end

    local function store_prompt_cursor()
        local prompt_win = get_state('prompt_win')
        if is_valid_win(prompt_win) then
            set_state('prompt_cursor', vim.api.nvim_win_get_cursor(prompt_win))
        end
    end

    local function restore_prompt_cursor(prompt_win, prompt_buf)
        if not is_valid_win(prompt_win) or not is_valid_buf(prompt_buf) then
            return
        end

        local line_count = math.max(vim.api.nvim_buf_line_count(prompt_buf), 1)
        local cursor = get_state('prompt_cursor')
        if type(cursor) ~= 'table' or #cursor < 2 then
            local line = vim.api.nvim_buf_get_lines(prompt_buf, line_count - 1, line_count, false)[1] or ''
            vim.api.nvim_win_set_cursor(prompt_win, { line_count, #line })
            return
        end

        local target_line = math.min(math.max(cursor[1], 1), line_count)
        local line = vim.api.nvim_buf_get_lines(prompt_buf, target_line - 1, target_line, false)[1] or ''
        local target_col = math.min(math.max(cursor[2], 0), #line)
        vim.api.nvim_win_set_cursor(prompt_win, { target_line, target_col })
    end

    local function set_prompt_window_options(prompt_buf, prompt_win)
        vim.bo[prompt_buf].buftype = 'nofile'
        vim.bo[prompt_buf].bufhidden = 'hide'
        vim.bo[prompt_buf].swapfile = false
        vim.bo[prompt_buf].filetype = 'markdown'
        vim.wo[prompt_win].number = false
        vim.wo[prompt_win].relativenumber = false
        vim.wo[prompt_win].signcolumn = 'no'
        vim.wo[prompt_win].winfixheight = true
        vim.wo[prompt_win].wrap = true
        vim.wo[prompt_win].cursorline = true
        vim.wo[prompt_win].winbar = config.prompt_winbar or ' USER PROMPT '
        vim.wo[prompt_win].statusline = config.prompt_statusline or ' USER PROMPT '
    end

    local function set_transcript_window_options(transcript_buf, transcript_win)
        mark_buffer(transcript_buf)
        vim.wo[transcript_win].winbar = config.transcript_winbar or ' CONVERSATION '
        vim.wo[transcript_win].statusline = config.transcript_statusline or ' TRANSCRIPT '

        if config.setup_transcript_buffer then
            config.setup_transcript_buffer(transcript_buf, transcript_win)
        end
    end

    local create_prompt_window
    local hide_prompt_window

    local function toggle_window()
        local current = vim.api.nvim_get_current_win()
        local prompt_win = get_state('prompt_win')

        if current == prompt_win then
            hide_prompt_window()
            return
        end

        local reopened_prompt = create_prompt_window()
        if is_valid_win(reopened_prompt) then
            vim.api.nvim_set_current_win(reopened_prompt)
            restore_prompt_cursor(reopened_prompt, get_state('prompt_buf'))
        end
    end

    local function add_keymaps(buf, channel_id)
        local map = vim.keymap.set
        local opts = { buffer = buf, silent = true }

        map('n', '<CR>', function()
            vim.fn.rpcnotify(channel_id, 'prompt_action', 'submit_pressed')
        end, vim.tbl_extend('force', opts, { desc = 'Submit prompt without writing scratch buffer' }))
        map('n', '<Tab>', toggle_window, vim.tbl_extend('force', opts, { desc = 'Toggle prompt split' }))
        map('n', '<S-Tab>', toggle_window, vim.tbl_extend('force', opts, { desc = 'Toggle prompt split' }))

        if config.extend_keymaps then
            config.extend_keymaps(buf, channel_id)
        end
    end

    create_prompt_window = function()
        local transcript_win = get_state('transcript_win')
        local prompt_buf = get_state('prompt_buf')
        local channel_id = get_state('channel')

        if not is_valid_win(transcript_win) then
            return nil
        end

        if not is_valid_buf(prompt_buf) then
            prompt_buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_buf_set_name(prompt_buf, config.prompt_buffer_name)
            vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '' })
            mark_buffer(prompt_buf)
            add_keymaps(prompt_buf, channel_id)
            set_state('prompt_buf', prompt_buf)
        end

        local prompt_win = get_state('prompt_win')
        if is_valid_win(prompt_win) then
            return prompt_win
        end

        prompt_win = with_autohide_suppressed(function()
            vim.api.nvim_set_current_win(transcript_win)
            vim.cmd('botright ' .. (config.prompt_height or 8) .. 'split')

            local new_prompt_win = vim.api.nvim_get_current_win()
            vim.api.nvim_win_set_buf(new_prompt_win, prompt_buf)
            set_prompt_window_options(prompt_buf, new_prompt_win)
            restore_prompt_cursor(new_prompt_win, prompt_buf)
            return new_prompt_win
        end)

        set_state('prompt_win', prompt_win)

        return prompt_win
    end

    hide_prompt_window = function()
        local prompt_win = get_state('prompt_win')
        if not is_valid_win(prompt_win) then
            set_state('prompt_win', nil)
            return
        end

        store_prompt_cursor()

        with_autohide_suppressed(function()
            local transcript_win = get_state('transcript_win')
            if vim.api.nvim_get_current_win() == prompt_win and is_valid_win(transcript_win) then
                vim.api.nvim_set_current_win(transcript_win)
            end
            pcall(vim.api.nvim_win_close, prompt_win, true)
        end)

        set_state('prompt_win', nil)
    end

    local function attach_transcript_autohide(transcript_buf)
        local autohide_key = state_key('prompt_autohide_attached')
        if vim.b[transcript_buf][autohide_key] then
            return
        end

        vim.b[transcript_buf][autohide_key] = true

        vim.api.nvim_create_autocmd('WinEnter', {
            buffer = transcript_buf,
            callback = function()
                if vim.g[state_key('suppress_prompt_autohide')] then
                    return
                end

                local transcript_win = get_state('transcript_win')
                if is_valid_win(transcript_win) and vim.api.nvim_get_current_win() == transcript_win then
                    hide_prompt_window()
                end
            end,
        })
    end

    local layout = {}

    function layout.setup(channel_id)
        local transcript_win = vim.api.nvim_get_current_win()
        local transcript_buf = vim.api.nvim_get_current_buf()
        local prompt_buf = vim.api.nvim_create_buf(false, true)

        vim.api.nvim_buf_set_name(prompt_buf, config.prompt_buffer_name)
        vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '' })

        set_transcript_window_options(transcript_buf, transcript_win)
        mark_buffer(prompt_buf)
        add_keymaps(transcript_buf, channel_id)
        add_keymaps(prompt_buf, channel_id)
        attach_transcript_autohide(transcript_buf)

        set_state('channel', channel_id)
        set_state('transcript_win', transcript_win)
        set_state('transcript_buf', transcript_buf)
        set_state('prompt_win', nil)
        set_state('prompt_buf', prompt_buf)
        set_state('prompt_cursor', nil)

        create_prompt_window()
    end

    function layout.get_prompt_text()
        local prompt_buf = get_state('prompt_buf')
        if not is_valid_buf(prompt_buf) then
            return ''
        end

        local lines = vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false)
        while #lines > 0 and lines[1]:match('^%s*$') do
            table.remove(lines, 1)
        end
        while #lines > 0 and lines[#lines]:match('^%s*$') do
            table.remove(lines)
        end

        return table.concat(lines, '\n')
    end

    function layout.clear_prompt()
        local prompt_buf = get_state('prompt_buf')
        if not is_valid_buf(prompt_buf) then
            return
        end

        vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '' })
        set_state('prompt_cursor', nil)
    end

    function layout.focus_prompt()
        local prompt_win = create_prompt_window()
        local prompt_buf = get_state('prompt_buf')
        if not is_valid_win(prompt_win) then
            return
        end

        vim.api.nvim_set_current_win(prompt_win)
        restore_prompt_cursor(prompt_win, prompt_buf)
    end

    function layout.refresh()
        local transcript_win = get_state('transcript_win')
        local prompt_win = get_state('prompt_win')
        local prompt_buf = get_state('prompt_buf')
        local current_win = vim.api.nvim_get_current_win()
        local prompt_cursor = nil

        if is_valid_win(prompt_win) then
            prompt_cursor = vim.api.nvim_win_get_cursor(prompt_win)
        end

        with_autohide_suppressed(function()
            if is_valid_win(transcript_win) then
                vim.api.nvim_win_call(transcript_win, function()
                    vim.cmd('silent keepalt keepjumps edit!')
                    vim.cmd('normal! G')
                end)
            end

            if is_valid_win(prompt_win) and is_valid_buf(prompt_buf) and prompt_cursor then
                set_state('prompt_cursor', prompt_cursor)
                restore_prompt_cursor(prompt_win, prompt_buf)
            end

            if is_valid_win(current_win) then
                vim.api.nvim_set_current_win(current_win)
            end
        end)

        pcall(vim.cmd, 'redraw!')
    end

    return layout
end

return M
