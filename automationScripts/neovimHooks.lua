local function setup_autosave()

    local home = vim.fn.expand("~")
    local script_path = home .. "/programming/kra-tmux/dest/automationScripts/autoSaveManager.js"

    local events = {
	"BufEnter", -- entering a buffer
        "BufDelete", -- closing a file/buffer
        "VimEnter", -- opening neovim
        "VimLeave", -- closing neovim
        "WinNew"    -- splitting screen (new window created)
    }


    for _, event in ipairs(events) do
        vim.api.nvim_create_autocmd(event, {
            pattern = "*",
            callback = function(args)
                -- get file path
                local file = vim.fn.expand("<afile>")
                if file == "" or file == nil then
                    file = vim.api.nvim_buf_get_name(0) -- current buffer name
                end

                -- filter unwanted buffers
                if file == "" or file == nil then
                    return
                end

                -- skip temporary, unnamed or plugin buffers
                local buftype = vim.api.nvim_buf_get_option(args.buf or 0, 'buftype')
                local filetype = vim.api.nvim_buf_get_option(args.buf or 0, 'filetype')

                -- skip if not a regular file buffer
                if buftype ~= "" then
                    return
                end

                -- plugin filetypes
                local skip_filetypes = {
                    "TelescopePrompt",
                    "TelescopeResults",
                    "TelescopePreview",
                    "fzf",
                    "NvimTree",
                    "neo-tree",
                    "fugitive",
                    "gitcommit",
                    "help",
                    "qf",
                    "loclist",
                    "netrw"
                }

                for _, ft in ipairs(skip_filetypes) do
                    if filetype == ft then
                        return
                    end
                end

                -- skip unnamed buffers and special paths
                if file:match("^%w+://") or file:match("^term://") or file:match("^fugitive://") then
                    return
                end

                local tmux_session = vim.fn.system("tmux display-message -p '#S'"):gsub("%s+", "")
                local tmux_window = vim.fn.system("tmux display-message -p '#I'"):gsub("%s+", "")
                local tmux_pane = vim.fn.system("tmux display-message -p '#P'"):gsub("%s+", "")

		-- check if in a tmux session
		if vim.v.shell_error ~= 0 or tmux_session == "" then
		    return
		end


                print("Event:", event, "Session:", tmux_session, "Window:", tmux_window, "Pane:", tmux_pane)

                local job_id = vim.fn.jobstart({
                    "node",
                    script_path,
                    tmux_session .. ":" .. tmux_window .. ":" .. tmux_pane .. ":neovim"
                }, {
                    detach = true,
                    on_stderr = function(_, data)
                        if data and #data > 0 then
                            print("Autosave script error: " .. table.concat(data, "\n"), vim.log.levels.ERROR)
                        end
                    end
                })

                if job_id <= 0 then
                    vim.notify("Failed to start autosave script", vim.log.levels.ERROR)
                end
            end
        })
    end
end

setup_autosave()
