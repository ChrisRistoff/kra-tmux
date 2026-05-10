local M = {}

function M.create(config)
    local function state_key(name)
        return config.namespace .. "_" .. name
    end

    local function get_state(name)
        return vim.g[state_key(name)]
    end

    local function set_state(name, value)
        vim.g[state_key(name)] = value
    end

    local function is_valid_win(win)
        return type(win) == "number" and vim.api.nvim_win_is_valid(win)
    end

    local function is_valid_buf(buf)
        return type(buf) == "number" and vim.api.nvim_buf_is_valid(buf)
    end

    local function mark_buffer(buf)
        vim.bo[buf].buflisted = false
        vim.b[buf].kra_agent_hide_filename = true
    end

    local function with_autohide_suppressed(callback)
        local suppress_key = state_key("suppress_prompt_autohide")
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
        local prompt_win = get_state("prompt_win")
        if is_valid_win(prompt_win) then
            set_state("prompt_cursor", vim.api.nvim_win_get_cursor(prompt_win))
        end
    end

    local function restore_prompt_cursor(prompt_win, prompt_buf)
        if not is_valid_win(prompt_win) or not is_valid_buf(prompt_buf) then
            return
        end

        local line_count = math.max(vim.api.nvim_buf_line_count(prompt_buf), 1)
        local cursor = get_state("prompt_cursor")
        if type(cursor) ~= "table" or #cursor < 2 then
            local line = vim.api.nvim_buf_get_lines(prompt_buf, line_count - 1, line_count, false)[1] or ""
            vim.api.nvim_win_set_cursor(prompt_win, { line_count, #line })
            return
        end

        local target_line = math.min(math.max(cursor[1], 1), line_count)
        local line = vim.api.nvim_buf_get_lines(prompt_buf, target_line - 1, target_line, false)[1] or ""
        local target_col = math.min(math.max(cursor[2], 0), #line)
        vim.api.nvim_win_set_cursor(prompt_win, { target_line, target_col })
    end

    local function set_prompt_window_options(prompt_buf, prompt_win)
        vim.bo[prompt_buf].buftype = "nofile"
        vim.bo[prompt_buf].bufhidden = "hide"
        vim.bo[prompt_buf].swapfile = false
        vim.bo[prompt_buf].filetype = "markdown"
        vim.bo[prompt_buf].undofile = false
        pcall(vim.api.nvim_set_option_value, "undolevels", -1, { buf = prompt_buf })


        vim.wo[prompt_win].number = false
        vim.wo[prompt_win].relativenumber = false
        vim.wo[prompt_win].signcolumn = "no"
        vim.wo[prompt_win].winfixheight = true
        vim.wo[prompt_win].wrap = true
        vim.wo[prompt_win].cursorline = true
        vim.wo[prompt_win].winbar = config.prompt_winbar or " USER PROMPT "
        vim.wo[prompt_win].statusline = config.prompt_statusline or " USER PROMPT "
    end

    local function set_transcript_window_options(transcript_buf, transcript_win)
        mark_buffer(transcript_buf)
        vim.bo[transcript_buf].undofile = false
        pcall(vim.api.nvim_set_option_value, "undolevels", -1, { buf = transcript_buf })


        vim.wo[transcript_win].winbar = config.transcript_winbar or " CONVERSATION "
        vim.wo[transcript_win].statusline = config.transcript_statusline or " TRANSCRIPT "

        if config.setup_transcript_buffer then
            config.setup_transcript_buffer(transcript_buf, transcript_win)
        end
    end

    local create_prompt_window
    local hide_prompt_window

    local function toggle_window()
        local current = vim.api.nvim_get_current_win()
        local prompt_win = get_state("prompt_win")

        if current == prompt_win then
            hide_prompt_window()
            return
        end

        local reopened_prompt = create_prompt_window()
        if is_valid_win(reopened_prompt) then
            vim.api.nvim_set_current_win(reopened_prompt)
            restore_prompt_cursor(reopened_prompt, get_state("prompt_buf"))
        end
    end

    local function add_keymaps(buf, channel_id)
        local map = vim.keymap.set
        local opts = { buffer = buf, silent = true }

        map("n", "<CR>", function()
            vim.fn.rpcnotify(channel_id, "prompt_action", "submit_pressed")
        end, vim.tbl_extend("force", opts, { desc = "Submit prompt without writing scratch buffer" }))
        map("n", "<Tab>", toggle_window, vim.tbl_extend("force", opts, { desc = "Toggle prompt split" }))
        map("n", "<S-Tab>", toggle_window, vim.tbl_extend("force", opts, { desc = "Toggle prompt split" }))

        if config.extend_keymaps then
            config.extend_keymaps(buf, channel_id)
        end
    end

    create_prompt_window = function()
        local transcript_win = get_state("transcript_win")
        local prompt_buf = get_state("prompt_buf")
        local channel_id = get_state("channel")

        if not is_valid_win(transcript_win) then
            return nil
        end

        if not is_valid_buf(prompt_buf) then
            prompt_buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_buf_set_name(prompt_buf, config.prompt_buffer_name)
            vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { "" })
            mark_buffer(prompt_buf)
            add_keymaps(prompt_buf, channel_id)
            set_state("prompt_buf", prompt_buf)
        end

        local prompt_win = get_state("prompt_win")
        if is_valid_win(prompt_win) then
            return prompt_win
        end

        prompt_win = with_autohide_suppressed(function()
            vim.api.nvim_set_current_win(transcript_win)
            vim.cmd("botright " .. (config.prompt_height or 8) .. "split")

            local new_prompt_win = vim.api.nvim_get_current_win()
            vim.api.nvim_win_set_buf(new_prompt_win, prompt_buf)
            set_prompt_window_options(prompt_buf, new_prompt_win)
            restore_prompt_cursor(new_prompt_win, prompt_buf)
            return new_prompt_win
        end)

        set_state("prompt_win", prompt_win)

        return prompt_win
    end

    hide_prompt_window = function()
        local prompt_win = get_state("prompt_win")
        if not is_valid_win(prompt_win) then
            set_state("prompt_win", nil)
            return
        end

        store_prompt_cursor()

        with_autohide_suppressed(function()
            local transcript_win = get_state("transcript_win")
            if vim.api.nvim_get_current_win() == prompt_win and is_valid_win(transcript_win) then
                vim.api.nvim_set_current_win(transcript_win)
            end
            pcall(vim.api.nvim_win_close, prompt_win, true)
        end)

        set_state("prompt_win", nil)
    end

    local function attach_transcript_autohide(transcript_buf)
        local autohide_key = state_key("prompt_autohide_attached")
        if vim.b[transcript_buf][autohide_key] then
            return
        end

        vim.b[transcript_buf][autohide_key] = true

        vim.api.nvim_create_autocmd("WinEnter", {
            buffer = transcript_buf,
            callback = function()
                if vim.g[state_key("suppress_prompt_autohide")] then
                    return
                end

                local transcript_win = get_state("transcript_win")
                if is_valid_win(transcript_win) and vim.api.nvim_get_current_win() == transcript_win then
                    hide_prompt_window()
                end
            end,
        })
    end
    -- Tail-windowing: keep only the last `tail_bytes` of the chat file in the
    -- transcript buffer. The rest stays on disk and is loaded on-demand when the
    -- user scrolls up. This bounds treesitter / render-markdown / Neovim redraw
    -- cost regardless of total chat size.
    local chat_file_path = nil
    local byte_start_in_file = 0
    local byte_end_in_file = 0
    local TAIL_BYTES_DEFAULT = 200000
    local tail_bytes = TAIL_BYTES_DEFAULT
    local head_loaded = true
    local has_history_sentinel = false
    local load_initial_tail, load_more_history, attach_history_loader, smart_refresh, trim_buffer_to_tail

    local function render_transcript_now(buf, win)
        pcall(function()
            local state = require("render-markdown.state")
            local ui = require("render-markdown.core.ui")
            state.get(buf)
            state.attach()
            ui.updater.new(buf, win, true):run()
        end)
    end

    local layout = {}

    function layout.setup(channel_id, chat_file_path_arg, opts)
        local transcript_win = vim.api.nvim_get_current_win()
        local transcript_buf = vim.api.nvim_get_current_buf()
        local prompt_buf = vim.api.nvim_create_buf(false, true)

        vim.api.nvim_buf_set_name(prompt_buf, config.prompt_buffer_name)
        vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { "" })

        set_transcript_window_options(transcript_buf, transcript_win)
        mark_buffer(prompt_buf)
        add_keymaps(transcript_buf, channel_id)
        add_keymaps(prompt_buf, channel_id)
        attach_transcript_autohide(transcript_buf)

        set_state("channel", channel_id)
        set_state("transcript_win", transcript_win)
        set_state("transcript_buf", transcript_buf)
        set_state("prompt_win", nil)
        set_state("prompt_buf", prompt_buf)
        set_state("prompt_cursor", nil)

        create_prompt_window()

        if type(chat_file_path_arg) == "string" and chat_file_path_arg ~= "" then
            chat_file_path = chat_file_path_arg
            if type(opts) == "table" and type(opts.tail_bytes) == "number" then
                tail_bytes = opts.tail_bytes
            end
            if type(opts) == "table" then
                if type(opts.scroll_tick_ms) == "number" and opts.scroll_tick_ms > 0 then
                    SCROLL_TICK_MS = opts.scroll_tick_ms
                end
                if type(opts.scroll_acceleration) == "number" and opts.scroll_acceleration > 0 then
                    SCROLL_ACCEL = opts.scroll_acceleration
                end
                if type(opts.append_debounce_ms) == "number" and opts.append_debounce_ms >= 0 then
                    APPEND_DEBOUNCE_MS = opts.append_debounce_ms
                end
            end
            -- Detach the transcript buffer from its file: no :edit! reload, no :w
            -- writes back to disk. TS owns all writes via fs.appendFile; this buffer
            -- is only ever a view into a (possibly truncated) tail of that file.
            pcall(function()
                vim.bo[transcript_buf].buftype = "nofile"
                vim.bo[transcript_buf].swapfile = false
            end)
            load_initial_tail()
            attach_history_loader(transcript_buf)
            render_transcript_now(transcript_buf, transcript_win)


            pcall(vim.keymap.set, "n", "gh", function()
                load_more_history()
            end, { buffer = transcript_buf, silent = true, desc = "Load more chat history" })
        end
    end

    function layout.get_prompt_text()
        local prompt_buf = get_state("prompt_buf")
        if not is_valid_buf(prompt_buf) then
            return ""
        end

        local lines = vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false)
        while #lines > 0 and lines[1]:match("^%s*$") do
            table.remove(lines, 1)
        end
        while #lines > 0 and lines[#lines]:match("^%s*$") do
            table.remove(lines)
        end

        return table.concat(lines, "\n")
    end

    function layout.clear_prompt()
        local prompt_buf = get_state("prompt_buf")
        if not is_valid_buf(prompt_buf) then
            return
        end

        vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { "" })
        set_state("prompt_cursor", nil)
    end

    function layout.focus_prompt()
        local prompt_win = create_prompt_window()
        local prompt_buf = get_state("prompt_buf")
        if not is_valid_win(prompt_win) then
            return
        end

        vim.api.nvim_set_current_win(prompt_win)
    end

    -- During streaming we DISABLE render-markdown.nvim on the transcript
    -- buffer. Its extmark recompute on every TextChanged is the dominant
    -- cost when chunks arrive at ~30 Hz; suspending it lets the buffer
    -- mutate at near-raw-speed and we re-enable it at flush boundaries
    -- (`streaming_ended`) for a single full repaint of the styled view.
    local streaming_active = false
    local function rm_buf_set(buf, on)
        if not is_valid_buf(buf) then return end
        local ok, rm = pcall(require, 'render-markdown')
        if not ok or not rm then return end
        -- buf_enable/buf_disable operate on the CURRENT buffer (no arg),
        -- so we have to swap into the transcript buffer's context first.
        pcall(vim.api.nvim_buf_call, buf, function()
            if on then
                if type(rm.buf_enable) == 'function' then
                    rm.buf_enable()
                end
                -- buf_enable does NOT auto-trigger a repaint, so kick one.
                if type(rm.render) == 'function' then
                    pcall(rm.render, { buf = buf, event = 'KraStreamEnd' })
                end
            else
                if type(rm.buf_disable) == 'function' then
                    rm.buf_disable()
                end
            end
        end)
    end

    -- Incremental append: write text to the END of the transcript buffer without
    -- reloading from disk. The TS host now paces deltas at ~60 Hz so we want
    -- the Lua side to flush each batch as soon as it lands — a long debounce
    -- here would just re-clump the carefully-spaced batches and re-introduce
    -- the visible "chunk" feel. 4 ms is enough to coalesce the back-to-back
    -- rpcnotify calls of a single tick, no more.
    local pending_append = ""
    local append_timer = nil
    -- Configurable from TS via setup() opts (forwarded from settings.toml
    -- [ai.chat_interface]). Defaults match the tuned values.
    local APPEND_DEBOUNCE_MS = 0

    -- Smooth auto-scroll animator. The TS pacer drips ~250 chars/sec; each
    -- newline would normally cause an instant 1-row scroll jump (cursor
    -- snap to bottom). We instead remember a target line and advance the
    -- cursor toward it 1 row per timer tick, so the viewport scrolls at a
    -- steady ~60 Hz instead of in instantaneous steps. If the model gets
    -- way ahead (target > current + a few rows) we accelerate so we never
    -- fall behind on a long response.
    local SCROLL_TICK_MS = 16
    local SCROLL_ACCEL = 8
    local cursor_target_line = nil
    local scroll_timer = nil

    local function stop_scroll_timer()
        if scroll_timer then
            pcall(function() scroll_timer:stop() end)
            pcall(function() scroll_timer:close() end)
            scroll_timer = nil
        end
    end

    local function tick_scroll()
        local transcript_buf = get_state("transcript_buf")
        local transcript_win = get_state("transcript_win")
        if not is_valid_buf(transcript_buf) or not is_valid_win(transcript_win) or cursor_target_line == nil then
            stop_scroll_timer()
            cursor_target_line = nil
            return
        end
        -- Don't fight a user reading / scrolling history.
        if vim.api.nvim_get_current_win() == transcript_win then
            stop_scroll_timer()
            cursor_target_line = nil
            return
        end
        local ok_cur, cur = pcall(vim.api.nvim_win_get_cursor, transcript_win)
        if not ok_cur then
            stop_scroll_timer()
            cursor_target_line = nil
            return
        end
        local current = cur[1]
        local target = cursor_target_line
        if current >= target then
            local last = vim.api.nvim_buf_get_lines(transcript_buf, target - 1, target, false)[1] or ""
            pcall(vim.api.nvim_win_set_cursor, transcript_win, { target, #last })
            cursor_target_line = nil
            stop_scroll_timer()
            return
        end
        local diff = target - current
        -- 1 row/tick when within 8 rows of target, accelerate beyond that.
        local step = math.max(1, math.floor(diff / SCROLL_ACCEL))
        local next_line = math.min(target, current + step)
        pcall(vim.api.nvim_win_set_cursor, transcript_win, { next_line, 0 })
    end

    local function schedule_smooth_scroll(target_line)
        cursor_target_line = target_line
        if not scroll_timer then
            scroll_timer = (vim.uv or vim.loop).new_timer()
            scroll_timer:start(SCROLL_TICK_MS, SCROLL_TICK_MS, vim.schedule_wrap(tick_scroll))
        end
    end

    local function flush_append()
        local transcript_buf = get_state("transcript_buf")
        if not is_valid_buf(transcript_buf) then
            pending_append = ""
            return
        end

        local text = pending_append
        pending_append = ""
        if text == "" then
            return
        end

        local last_line = vim.api.nvim_buf_line_count(transcript_buf)
        local last_line_content = vim.api.nvim_buf_get_lines(transcript_buf, last_line - 1, last_line, false)[1] or ""
        local last_col = #last_line_content
        local lines = vim.split(text, "\n", { plain = true })

        local was_modifiable = vim.bo[transcript_buf].modifiable
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = true
        end
        pcall(vim.api.nvim_buf_set_text, transcript_buf, last_line - 1, last_col, last_line - 1, last_col, lines)
        byte_end_in_file = byte_end_in_file + #text
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = false
        end

        -- Buffer + disk are kept in sync by the TS side (it appends the same
        -- text to the file). Clear the modified flag so :edit! at boundaries
        -- is a no-op reload and no "buffer modified" warnings appear.
        pcall(function()
            vim.bo[transcript_buf].modified = false
        end)

        -- Auto-scroll the transcript window only if the user isn't currently
        -- focused on it (don't fight a user reading / scrolling history).
        local transcript_win = get_state("transcript_win")
        if is_valid_win(transcript_win) and vim.api.nvim_get_current_win() ~= transcript_win then
            local new_count = vim.api.nvim_buf_line_count(transcript_buf)
            schedule_smooth_scroll(new_count)
        end

        if chat_file_path then
            trim_buffer_to_tail(transcript_buf)
        end
    end
    -- ---- Tail-windowing helpers (defined after flush_append so they can
    -- close over pending_append / flush_append).

    local function fs_size(path)
        local stat = vim.loop.fs_stat(path)
        return stat and stat.size or 0
    end

    local function fs_read_range(path, offset, length)
        if length <= 0 then
            return ""
        end
        local fd = vim.loop.fs_open(path, "r", 438)
        if not fd then
            return ""
        end
        local data = vim.loop.fs_read(fd, length, offset)
        vim.loop.fs_close(fd)
        return data or ""
    end

    local function format_history_sentinel(bytes_above)
        local label
        if bytes_above < 1024 then
            label = bytes_above .. " B"
        elseif bytes_above < 1024 * 1024 then
            label = string.format("%.1f KB", bytes_above / 1024)
        else
            label = string.format("%.2f MB", bytes_above / (1024 * 1024))
        end
        return "<!-- \xe2\x94\x80\xe2\x94\x80 "
            .. label
            .. " earlier \xe2\x80\x94 scroll up or press gh to load more \xe2\x94\x80\xe2\x94\x80 -->"
    end

    local function update_history_sentinel(transcript_buf)
        if not is_valid_buf(transcript_buf) then
            return
        end
        local was_modifiable = vim.bo[transcript_buf].modifiable
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = true
        end
        if byte_start_in_file > 0 then
            local sentinel = format_history_sentinel(byte_start_in_file)
            if has_history_sentinel then
                vim.api.nvim_buf_set_lines(transcript_buf, 0, 1, false, { sentinel })
            else
                vim.api.nvim_buf_set_lines(transcript_buf, 0, 0, false, { sentinel })
                has_history_sentinel = true
            end
        elseif has_history_sentinel then
            vim.api.nvim_buf_set_lines(transcript_buf, 0, 1, false, {})
            has_history_sentinel = false
        end
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = false
        end
        pcall(function()
            vim.bo[transcript_buf].modified = false
        end)
    end

    load_initial_tail = function()
        if not chat_file_path then
            return
        end
        local transcript_buf = get_state("transcript_buf")
        if not is_valid_buf(transcript_buf) then
            return
        end
        local size = fs_size(chat_file_path)
        byte_end_in_file = size
        if size <= tail_bytes then
            byte_start_in_file = 0
            head_loaded = true
        else
            local raw = fs_read_range(chat_file_path, size - tail_bytes, tail_bytes)
            local nl = raw:find("\n")
            byte_start_in_file = nl and (size - tail_bytes + nl) or (size - tail_bytes)
            head_loaded = false
        end
        local content = fs_read_range(chat_file_path, byte_start_in_file, byte_end_in_file - byte_start_in_file)
        local lines = vim.split(content, "\n", { plain = true })
        if #lines == 0 then
            lines = { "" }
        end
        local was_modifiable = vim.bo[transcript_buf].modifiable
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = true
        end
        vim.api.nvim_buf_set_lines(transcript_buf, 0, -1, false, lines)
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = false
        end
        pcall(function()
            vim.bo[transcript_buf].modified = false
        end)
        has_history_sentinel = false
        update_history_sentinel(transcript_buf)
        update_history_sentinel(transcript_buf)
    end

    trim_buffer_to_tail = function(transcript_buf)
        if not chat_file_path then
            return
        end
        if (byte_end_in_file - byte_start_in_file) <= 2 * tail_bytes then
            return
        end

        local transcript_win = get_state("transcript_win")
        if is_valid_win(transcript_win) and vim.api.nvim_get_current_win() == transcript_win then
            return
        end

        local new_target_start = byte_end_in_file - tail_bytes
        local read_len = byte_end_in_file - new_target_start
        local raw = fs_read_range(chat_file_path, new_target_start, read_len)
        if not raw then
            return
        end

        local actual_start = new_target_start
        if new_target_start > 0 then
            local nl = raw:find("\n", 1, true)
            if nl then
                raw = raw:sub(nl + 1)
                actual_start = new_target_start + nl
            end
        end

        local lines = vim.split(raw, "\n", { plain = true })
        local was_modifiable = vim.bo[transcript_buf].modifiable
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = true
        end
        pcall(vim.api.nvim_buf_set_lines, transcript_buf, 0, -1, false, lines)
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = false
        end
        pcall(function()
            vim.bo[transcript_buf].modified = false
        end)

        byte_start_in_file = actual_start
        head_loaded = (actual_start == 0)
        has_history_sentinel = false
        update_history_sentinel(transcript_buf)

        if is_valid_win(transcript_win) then
            local n = vim.api.nvim_buf_line_count(transcript_buf)
            local last = vim.api.nvim_buf_get_lines(transcript_buf, n - 1, n, false)[1] or ""
            pcall(vim.api.nvim_win_set_cursor, transcript_win, { n, #last })
        end
    end

    load_more_history = function()
        if head_loaded or not chat_file_path then
            return
        end
        local transcript_buf = get_state("transcript_buf")
        if not is_valid_buf(transcript_buf) then
            return
        end
        local new_start = math.max(0, byte_start_in_file - tail_bytes)
        local read_len = byte_start_in_file - new_start
        local raw = fs_read_range(chat_file_path, new_start, read_len)
        local actual_start = new_start
        if new_start > 0 then
            local nl = raw:find("\n")
            if nl then
                raw = raw:sub(nl + 1)
                actual_start = new_start + nl
            end
        end
        local lines = vim.split(raw, "\n", { plain = true })
        if #lines > 0 and lines[#lines] == "" then
            table.remove(lines)
        end
        if #lines == 0 then
            return
        end
        local transcript_win = get_state("transcript_win")
        local view = nil
        if is_valid_win(transcript_win) then
            view = vim.api.nvim_win_call(transcript_win, function()
                return vim.fn.winsaveview()
            end)
        end
        local before_count = vim.api.nvim_buf_line_count(transcript_buf)
        local was_modifiable = vim.bo[transcript_buf].modifiable
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = true
        end
        local replace_to = has_history_sentinel and 1 or 0
        vim.api.nvim_buf_set_lines(transcript_buf, 0, replace_to, false, lines)
        has_history_sentinel = false
        byte_start_in_file = actual_start
        head_loaded = (actual_start == 0)
        if not was_modifiable then
            vim.bo[transcript_buf].modifiable = false
        end
        pcall(function()
            vim.bo[transcript_buf].modified = false
        end)
        update_history_sentinel(transcript_buf)
        if view and is_valid_win(transcript_win) then
            local after_count = vim.api.nvim_buf_line_count(transcript_buf)
            local shift = after_count - before_count
            view.topline = view.topline + shift
            view.lnum = view.lnum + shift
            pcall(vim.api.nvim_win_call, transcript_win, function()
                vim.fn.winrestview(view)
            end)
        end
    end

    attach_history_loader = function(transcript_buf)
        local hist_key = state_key("history_loader_attached")
        if vim.b[transcript_buf][hist_key] then
            return
        end
        vim.b[transcript_buf][hist_key] = true
        vim.api.nvim_create_autocmd("WinScrolled", {
            buffer = transcript_buf,
            callback = function()
                if head_loaded then
                    return
                end
                local transcript_win = get_state("transcript_win")
                if not is_valid_win(transcript_win) then
                    return
                end
                local topline = vim.api.nvim_win_call(transcript_win, function()
                    return vim.fn.line("w0")
                end)
                if topline <= 2 then
                    load_more_history()
                end
            end,
        })
    end

    smart_refresh = function()
        if not chat_file_path then
            return false
        end
        local transcript_buf = get_state("transcript_buf")
        if not is_valid_buf(transcript_buf) then
            return true
        end
        -- Always reload the visible tail from disk. Pure-append diffing was unsafe
        -- because TS code paths mutate the chat file in-place (e.g.
        -- materializeUserDraft rewriting `(draft)` -> `· timestamp`), and a
        -- diff-append would slice into the middle of a rewritten line.
        -- load_initial_tail is bounded (reads at most tail_bytes), so this is
        -- still cheap relative to a full :edit! reload of an unbounded file.
        -- Drop any in-flight pending bytes; we're about to replace the buffer
        -- entirely from disk, so the in-memory tail is now stale.
        pending_append = ""
        load_initial_tail()
        return true
    end

    function layout.append_text(text)
        if type(text) ~= "string" or text == "" then
            return
        end
        pending_append = pending_append .. text
        if append_timer then
            return
        end
        append_timer = vim.defer_fn(function()
            append_timer = nil
            flush_append()
        end, APPEND_DEBOUNCE_MS)
    end

    -- Called by the TS host immediately before it begins streaming a
    -- response. Disables render-markdown on the transcript buffer so the
    -- per-chunk extmark recompute storm doesn't drag the UI. The buffer
    -- still receives raw markdown text — syntax highlighting via
    -- treesitter is the only style applied during streaming. The plugin
    -- is re-enabled by `streaming_ended` for a single batched repaint.
    function layout.streaming_started()
        if streaming_active then return end
        streaming_active = true
        local transcript_buf = get_state("transcript_buf")
        rm_buf_set(transcript_buf, false)
    end

    function layout.streaming_ended()
        if not streaming_active then return end
        streaming_active = false
        if append_timer then
            pcall(function() append_timer:stop(); append_timer:close() end)
            append_timer = nil
        end
        flush_append()
        local transcript_buf = get_state("transcript_buf")
        rm_buf_set(transcript_buf, true)
    end

    function layout.refresh()
        -- Flush any pending streaming text into the buffer first.
        if append_timer then
            pcall(function()
                append_timer:stop()
                append_timer:close()
            end)
            append_timer = nil
        end
        flush_append()

        -- Tail-windowing path: cheap on-disk diff sync, no full reload.
        if smart_refresh() then
            local transcript_win = get_state("transcript_win")
            local transcript_buf = get_state("transcript_buf")
            render_transcript_now(transcript_buf, transcript_win)
            if is_valid_win(transcript_win) then
                pcall(vim.api.nvim_win_call, transcript_win, function()
                    vim.cmd("normal! G")
                end)
            end
            pcall(vim.cmd, "redraw")
            return
        end

        -- Legacy fallback for callers that didn't set chat_file_path.
        local transcript_win = get_state("transcript_win")
        local prompt_win = get_state("prompt_win")
        local prompt_buf = get_state("prompt_buf")
        local current_win = vim.api.nvim_get_current_win()
        local prompt_cursor = nil

        if is_valid_win(prompt_win) then
            prompt_cursor = vim.api.nvim_win_get_cursor(prompt_win)
        end

        with_autohide_suppressed(function()
            if is_valid_win(transcript_win) then
                vim.api.nvim_win_call(transcript_win, function()
                    vim.cmd("silent keepalt keepjumps edit!")
                    vim.cmd("normal! G")
                end)
            end

            if is_valid_win(prompt_win) and is_valid_buf(prompt_buf) and prompt_cursor then
                set_state("prompt_cursor", prompt_cursor)
                restore_prompt_cursor(prompt_win, prompt_buf)
            end

            if is_valid_win(current_win) then
                vim.api.nvim_set_current_win(current_win)
            end
        end)

        render_transcript_now(get_state("transcript_buf"), get_state("transcript_win"))

        pcall(vim.cmd, "redraw!")
    end
    return layout
end

return M
