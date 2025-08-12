local function setup_autosave()
    local home = vim.fn.expand("~")
    local script_path = home .. "/programming/kra-tmux/dest/automationScripts/autoSaveManager.js"
    local debounce_timer = nil
    local pending_execution = false
    local server_address = nil
    local our_socket_path = nil
    local events = { "BufReadPost", "BufDelete", "VimLeave", "WinClosed" }

    -- validate script exists
    if vim.fn.filereadable(script_path) == 0 then
        print("Autosave: Script not found at " .. script_path)
        return
    end

    local function is_socket_in_use(socket_path)
        -- connect to socket to see if active
        local handle = vim.loop.new_pipe()
        if not handle then return false end

        local connected = false
        handle:connect(socket_path, function(err)
            connected = (err == nil)
        end)

        vim.wait(50, function() return connected end)
        handle:close()

        return connected
    end

    local function safe_cleanup_socket(socket_path)
        if socket_path and vim.fn.filereadable(socket_path) == 1 then
            -- clean up if it's not in use
            if not is_socket_in_use(socket_path) then
                vim.fn.delete(socket_path)
            end
        end
    end

    local function get_unique_socket_path()
        local pid = vim.fn.getpid()
        local timestamp = vim.fn.localtime()
        local random = math.random(1000, 9999)

        local base_path = "/tmp/nvim_" .. pid .. "_" .. timestamp .. "_" .. random
        local socket_path = base_path .. ".sock"

        -- if socket path exists, try more variations
        local counter = 0
        while vim.fn.filereadable(socket_path) == 1 and counter < 10 do
            counter = counter + 1
            socket_path = base_path .. "_" .. counter .. ".sock"
        end

        -- clean up if we're sure it's stale
        if vim.fn.filereadable(socket_path) == 1 then
            safe_cleanup_socket(socket_path)
        end

        return socket_path
    end

    local function execute_script(event_name)
        if pending_execution then return end
        pending_execution = true

        -- get tmux identifiers first to fail fast
        local tmux_session = vim.fn.system("tmux display-message -p '#S'"):gsub("%s+", "")
        if vim.v.shell_error ~= 0 then
            pending_execution = false
            return
        end

        local tmux_window = vim.fn.system("tmux display-message -p '#I'"):gsub("%s+", "")
        local tmux_pane = vim.fn.system("tmux display-message -p '#P'"):gsub("%s+", "")

        -- check server already running
        if server_address and server_address ~= "" then
            -- use existing server
            local session_id = table.concat({ "neovim", tmux_session, tmux_window, tmux_pane, our_socket_path }, ":")
        else
            -- create server
            local socket_path = get_unique_socket_path()

            -- start server
            local server_result = vim.fn.serverstart(socket_path)

            if server_result == "" then
                print("Autosave: Failed to start server at " .. socket_path)
                pending_execution = false
                return
            end

            server_address = server_result
            our_socket_path = socket_path
        end

        local session_id = table.concat({ "neovim", tmux_session, tmux_window, tmux_pane, event_name, our_socket_path }, ":")

        -- check buffer type
        local buftype = vim.api.nvim_buf_get_option(0, 'buftype')
        local filetype = vim.api.nvim_buf_get_option(0, 'filetype')
        if buftype ~= "" or filetype == "gitcommit" then
            pending_execution = false
            return
        end

        vim.fn.jobstart({ "node", script_path, session_id }, {
            detach = true,
            on_exit = function(_, exit_code)
                pending_execution = false
                if exit_code ~= 0 and exit_code ~= 130 then -- 130 is SIGINT, normal
                    print("Autosave: Script exited with code " .. exit_code)
                end
            end,

            on_stderr = function(_, data)
                local filtered_data = vim.tbl_filter(function(s)
                    return s ~= nil and s ~= '' and s:match("%S")
                end, data)

                if #filtered_data > 0 then
                    local msg = table.concat(filtered_data, "\n")
                    print("Autosave error: " .. msg)
                end
            end,

            on_stdout = function(_, data)
                local filtered_data = vim.tbl_filter(function(s)
                    return s ~= nil and s ~= '' and s:match("%S")
                end, data)

                if #filtered_data > 0 then
                    local msg = table.concat(filtered_data, "\n")
                    print("Autosave: " .. msg)
                end
            end
        })
    end

    -- cleanup only our resources on exit
    vim.api.nvim_create_autocmd("VimLeavePre", {
        callback = function()
            if server_address then
                vim.fn.serverstop(server_address)
                server_address = nil
            end

            -- only clean up our own socket
            if our_socket_path then
                safe_cleanup_socket(our_socket_path)
                our_socket_path = nil
            end
        end
    })

    -- create autocmds
    for _, event in ipairs(events) do
        if event == "VimLeave" then
            -- Handle VimLeave immediately without debouncing
            vim.api.nvim_create_autocmd(event, {
                pattern = "*",
                callback = function()
                    execute_script(event)
                end
            })
        else
            vim.api.nvim_create_autocmd(event, {
                pattern = "*",
                callback = function()
                    -- clean existing timer
                    if debounce_timer then
                        if not debounce_timer:is_closing() then
                            debounce_timer:stop()
                            debounce_timer:close()
                        end
                    end

                    -- new timer - pass the event name to execute_script
                    debounce_timer = vim.loop.new_timer()
                    if debounce_timer then
                        debounce_timer:start(3000, 0, vim.schedule_wrap(function()
                            execute_script(event)
                            if debounce_timer and not debounce_timer:is_closing() then
                                debounce_timer:close()
                            end
                            debounce_timer = nil
                        end))
                    end
                end
            })
        end
    end
end

setup_autosave()
