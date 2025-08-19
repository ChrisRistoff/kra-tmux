local function setup_autosave()
    local home = vim.fn.expand("~")
    local script_path = home .. "/programming/kra-tmux/dest/automationScripts/autosave/autoSaveManager.js"

    if vim.fn.filereadable(script_path) == 0 then
        print("Autosave: Script not found at " .. script_path)
        return
    end

    local pending_execution = false
    local debounce_timer = nil
    local socket_lifetime_timer = nil
    local server_address = nil
    local our_socket_path = nil

    -- Expanded exclusion list for common plugins
    local excluded_filetypes = {
        "NvimTree", "TelescopePrompt", "packer", "cmp_menu", "which_key",
        "gitcommit", "fugitive", "gh", "help", "qf", "quickfix", "loclist",
        "fzf", "lazy", "mason", "lspinfo", "null-ls-info", "checkhealth",
        "man", "oil", "neo-tree", "trouble", "noice", "notify", "alpha",
        "dashboard", "startify", "aerial", "undotree", "diff", "fugitiveblame"
    }

    -- More comprehensive buffer validation
    local function is_real_file_buffer(buf)
        -- Skip if buffer is invalid
        if not vim.api.nvim_buf_is_valid(buf) then
            return false
        end

        -- Check buffer type - only allow normal file buffers
        local buftype = vim.api.nvim_buf_get_option(buf, "buftype")
        if buftype ~= "" then
            return false
        end

        -- Check if buffer is listed
        if not vim.api.nvim_buf_get_option(buf, "buflisted") then
            return false
        end

        -- Check filetype exclusions
        local filetype = vim.api.nvim_buf_get_option(buf, "filetype")
        for _, excluded in ipairs(excluded_filetypes) do
            if filetype == excluded then
                return false
            end
        end

        -- Check if buffer has a real file path
        local bufname = vim.api.nvim_buf_get_name(buf)
        if bufname == "" then
            return false
        end

        -- Exclude special schemes and temporary files
        if bufname:match("^%w+://") or         -- URLs/schemes like oil://, fugitive://
            bufname:match("^/tmp/") or         -- Temp files
            bufname:match("^term://") or       -- Terminal buffers
            bufname:match("%.git/") or         -- Git internals
            bufname:match("COMMIT_EDITMSG") or -- Git commit messages
            bufname:match("MERGE_MSG") then    -- Git merge messages
            return false
        end

        -- Only proceed if it's an actual file that exists or is new
        local file_readable = vim.fn.filereadable(bufname) == 1
        local file_exists = vim.fn.filewritable(vim.fn.fnamemodify(bufname, ":h")) == 2

        return file_readable or file_exists
    end

    local visible_file_buffers = {}

    local function get_current_file_buffers()
        local current = {}
        for _, win in ipairs(vim.api.nvim_list_wins()) do
            local buf = vim.api.nvim_win_get_buf(win)
            if is_real_file_buffer(buf) then
                current[buf] = true
            end
        end
        return current
    end

    local function buffers_changed(old, new)
        -- Check if any buffers were added or removed
        for buf in pairs(old) do
            if not new[buf] then
                return true -- buffer removed
            end
        end
        for buf in pairs(new) do
            if not old[buf] then
                return true -- buffer added
            end
        end
        return false
    end

    local function get_unique_socket_path()
        local pid = vim.fn.getpid()
        local timestamp = vim.fn.localtime()
        local random = math.random(1000, 9999)
        return "/tmp/nvim_" .. pid .. "_" .. timestamp .. "_" .. random .. ".sock"
    end

    local function ensure_server_running()
        if server_address and vim.fn.serverlist()[server_address] then
            return true
        end

        local socket_path = get_unique_socket_path()
        vim.fn.mkdir(vim.fn.fnamemodify(socket_path, ":h"), "p")
        local server_result = vim.fn.serverstart(socket_path)

        if server_result ~= "" then
            server_address = server_result
            our_socket_path = socket_path

            if socket_lifetime_timer then
                socket_lifetime_timer:stop()
                socket_lifetime_timer:close()
            end
            socket_lifetime_timer = vim.loop.new_timer()
            socket_lifetime_timer:start(600000, 0, vim.schedule_wrap(function()
                if server_address then
                    vim.fn.serverstop(server_address)
                    server_address = nil
                end
                if our_socket_path then
                    vim.fn.delete(our_socket_path)
                    our_socket_path = nil
                end
                socket_lifetime_timer:close()
                socket_lifetime_timer = nil
            end))

            return true
        end

        print("Autosave: Failed to start server")
        return false
    end

    local function execute_script(event_name)
        if pending_execution then return end
        pending_execution = true

        local tmux_session = vim.fn.system("tmux display-message -p '#S'"):gsub("%s+", "")
        if vim.v.shell_error ~= 0 then
            pending_execution = false
            return
        end
        local tmux_window = vim.fn.system("tmux display-message -p '#I'"):gsub("%s+", "")
        local tmux_pane = vim.fn.system("tmux display-message -p '#P'"):gsub("%s+", "")

        if not ensure_server_running() then
            pending_execution = false
            return
        end

        local session_id = table.concat({ "neovim", tmux_session, tmux_window, tmux_pane, event_name, our_socket_path },
            ":")

        vim.fn.jobstart({ "node", script_path, session_id }, {
            detach = true,
            on_exit = function(_, exit_code)
                pending_execution = false
                if exit_code ~= 0 and exit_code ~= 130 then
                    print("Autosave: Script exited with code " .. exit_code)
                end
            end,
            on_stderr = function(_, data)
                local filtered_data = vim.tbl_filter(function(s) return s and s:match("%S") end, data)
                if #filtered_data > 0 then print("Autosave error: " .. table.concat(filtered_data, "\n")) end
            end,
            on_stdout = function(_, data)
                local filtered_data = vim.tbl_filter(function(s) return s and s:match("%S") end, data)
                if #filtered_data > 0 then print("Autosave: " .. table.concat(filtered_data, "\n")) end
            end
        })
    end

    -- Initial snapshot of file buffers
    visible_file_buffers = get_current_file_buffers()

    local function schedule_autosave(event_name)
        if debounce_timer and not debounce_timer:is_closing() then
            debounce_timer:stop()
            debounce_timer:close()
        end

        debounce_timer = vim.loop.new_timer()
        debounce_timer:start(500, 0, vim.schedule_wrap(function()
            local new_buffers = get_current_file_buffers()
            if buffers_changed(visible_file_buffers, new_buffers) then
                execute_script(event_name)
            end
            visible_file_buffers = new_buffers

            if debounce_timer and not debounce_timer:is_closing() then
                debounce_timer:close()
            end
            debounce_timer = nil
        end))
    end

    -- Only track specific events that matter for file buffers
    local events = {
        "BufEnter",    -- When entering a buffer (covers switching)
        "BufWinEnter", -- When buffer is displayed in window (covers splits)
        "BufDelete",   -- When buffer is deleted
        "WinClosed"    -- When window is closed
    }

    for _, event in ipairs(events) do
        vim.api.nvim_create_autocmd(event, {
            pattern = "*",
            callback = function(args)
                local buf = args.buf or vim.api.nvim_get_current_buf()

                -- Only proceed if the event involves a real file buffer
                -- or if we need to check for buffer changes (like WinClosed)
                if event == "WinClosed" or is_real_file_buffer(buf) then
                    schedule_autosave(event)
                end
            end
        })
    end

    -- Cleanup on exit
    vim.api.nvim_create_autocmd("VimLeavePre", {
        callback = function()
            execute_script("VimLeave")
            if server_address then
                vim.fn.serverstop(server_address)
                server_address = nil
            end
            if our_socket_path then
                vim.fn.delete(our_socket_path)
                our_socket_path = nil
            end
            if socket_lifetime_timer then
                socket_lifetime_timer:stop()
                socket_lifetime_timer:close()
                socket_lifetime_timer = nil
            end
        end
    })
end

setup_autosave()
