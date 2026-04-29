local M = {}

local rpc = require("kra_agent.util.rpc")

local function prompt_add_memory(view)
    vim.ui.input({ prompt = "Memory title: " }, function(title)
        if not title or title == "" then
            return
        end
        vim.ui.input({ prompt = "Memory body:  " }, function(body)
            if not body or body == "" then
                return
            end
            vim.ui.input({ prompt = "Tags (csv, optional): " }, function(tags)
                vim.ui.select(
                    { "note", "bug-fix", "gotcha", "decision", "investigation", "revisit" },
                    { prompt = "Kind:" },
                    function(kind)
                        if not kind then
                            return
                        end
                        rpc.send_action("add_memory", {
                            title = title,
                            body = body,
                            tags = tags or "",
                            kind = kind,
                            view = view or "all",
                        })
                    end
                )
            end)
        end)
    end)
end

local function memory_entry_maker(entry)
    local status_icon = entry.status == "open" and "" or "·"
    local tags = (entry.tags and #entry.tags > 0) and (" #" .. table.concat(entry.tags, " #")) or ""
    return {
        value = entry,
        display = string.format("%s [%s] %s%s", status_icon, entry.kind, entry.title, tags),
        ordinal = string.format(
            "%s %s %s %s",
            entry.kind,
            entry.title,
            entry.body or "",
            table.concat(entry.tags or {}, " ")
        ),
    }
end

local function render_memory_preview(self, entry)
    local item = entry.value
    local lines = {
        string.format("id:      %s", item.id),
        string.format("kind:    %s", item.kind),
        string.format("status:  %s", item.status or ""),
        string.format("tags:    %s", table.concat(item.tags or {}, ", ")),
        string.format("paths:   %s", table.concat(item.paths or {}, ", ")),
        string.format("created: %s", os.date("%Y-%m-%d %H:%M:%S", math.floor((item.createdAt or 0) / 1000))),
        "",
        "# " .. (item.title or ""),
        "",
    }
    for line in (item.body or ""):gmatch("([^\n]*)\n?") do
        table.insert(lines, line)
    end
    vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false, lines)
end

function M.show_memory_browser(items, view)
    local ok, err = pcall(function()
        local pickers = require("telescope.pickers")
        local finders = require("telescope.finders")
        local previewers = require("telescope.previewers")
        local conf = require("telescope.config").values
        local actions = require("telescope.actions")
        local action_state = require("telescope.actions.state")

        items = items or {}
        view = view or "all"

        local function next_view(current)
            if current == "all" then
                return "findings"
            end
            if current == "findings" then
                return "revisits"
            end
            return "all"
        end

        local function counts(list)
            local f, r = 0, 0
            for _, it in ipairs(list) do
                if it.kind == "revisit" then
                    r = r + 1
                else
                    f = f + 1
                end
            end
            return f, r
        end

        if #items == 0 then
            vim.notify(
                "No memories in view \"" .. view .. "\". Press \"a\" to add, <Tab> to switch view.",
                vim.log.levels.INFO,
                { title = "kra-memory" }
            )
        end

        local f_count, r_count = counts(items)
        local title = string.format(
            "kra-memory [%s]  findings:%d revisits:%d  [<CR>:open  <Tab>:view  a:add  dd:del]",
            view,
            f_count,
            r_count
        )

        pickers
            .new({
                layout_strategy = "horizontal",
                layout_config = { preview_width = 0.55, width = 0.95, height = 0.85 },
            }, {
                prompt_title = title,
                finder = finders.new_table({
                    results = items,
                    entry_maker = memory_entry_maker,
                }),
                previewer = previewers.new_buffer_previewer({
                    title = "Memory body",
                    define_preview = render_memory_preview,
                }),
                sorter = conf.generic_sorter({}),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local sel = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        if sel and sel.value then
                            M.open_memory_buffer(sel.value, view)
                        end
                    end)

                    map("n", "<Tab>", function()
                        actions.close(prompt_bufnr)
                        rpc.send_action("browse_memory", { view = next_view(view) })
                    end)
                    map("i", "<Tab>", function()
                        actions.close(prompt_bufnr)
                        rpc.send_action("browse_memory", { view = next_view(view) })
                    end)

                    map("n", "a", function()
                        actions.close(prompt_bufnr)
                        prompt_add_memory(view)
                    end)
                    map("i", "<C-a>", function()
                        actions.close(prompt_bufnr)
                        prompt_add_memory(view)
                    end)

                    map("n", "dd", function()
                        local sel = action_state.get_selected_entry()
                        if not sel then
                            return
                        end
                        local id = sel.value.id
                        vim.ui.select({ "Yes, delete", "No, cancel" }, {
                            prompt = "Delete \"" .. (sel.value.title or "?") .. "\"?",
                        }, function(choice)
                            if choice == "Yes, delete" then
                                actions.close(prompt_bufnr)
                                rpc.send_action("delete_memory", { id = id, view = view })
                            end
                        end)
                    end)
                    map("n", "D", function()
                        local sel = action_state.get_selected_entry()
                        if not sel then
                            return
                        end
                        local id = sel.value.id
                        actions.close(prompt_bufnr)
                        rpc.send_action("delete_memory", { id = id, view = view })
                    end)

                    return true
                end,
            })
            :find()
    end)

    if not ok then
        vim.notify("kra-memory browser failed: " .. tostring(err), vim.log.levels.ERROR)
    end
end

function M.pick_memories(channel_id, items, opts)
    local ok, err = pcall(function()
        local pickers = require("telescope.pickers")
        local finders = require("telescope.finders")
        local previewers = require("telescope.previewers")
        local conf = require("telescope.config").values
        local actions = require("telescope.actions")
        local action_state = require("telescope.actions.state")

        items = items or {}
        opts = opts or {}

        local function notify_selection(ids)
            pcall(vim.fn.rpcnotify, channel_id, "memory_picker_selection", ids and vim.fn.json_encode(ids) or nil)
        end

        pickers.new({
            layout_strategy = "horizontal",
            layout_config = { preview_width = 0.55, width = 0.95, height = 0.85 },
        }, {
            prompt_title = (opts.title or "Select memories") .. "  [↑↓:move  <Tab>:toggle multi  <CR>:confirm  <Esc>:cancel]",
            finder = finders.new_table({ results = items, entry_maker = memory_entry_maker }),
            previewer = previewers.new_buffer_previewer({
                title = "Memory body",
                define_preview = render_memory_preview,
            }),
            sorter = conf.generic_sorter({}),
            attach_mappings = function(prompt_bufnr, map)
                local function finish_selection()
                    local picker = action_state.get_current_picker(prompt_bufnr)
                    local multi = picker:get_multi_selection()
                    local selected_ids = {}
                    local seen = {}

                    if multi and #multi > 0 then
                        for _, item in ipairs(multi) do
                            local id = item.value and item.value.id
                            if type(id) == "string" and not seen[id] then
                                table.insert(selected_ids, id)
                                seen[id] = true
                            end
                        end
                    else
                        local current = action_state.get_selected_entry()
                        local id = current and current.value and current.value.id
                        if type(id) == "string" then
                            table.insert(selected_ids, id)
                        end
                    end

                    actions.close(prompt_bufnr)
                    notify_selection(selected_ids)
                end

                local function cancel_selection()
                    actions.close(prompt_bufnr)
                    notify_selection(nil)
                end

                actions.select_default:replace(finish_selection)
                map("i", "<Tab>", function()
                    actions.toggle_selection(prompt_bufnr)
                end)
                map("n", "<Tab>", function()
                    actions.toggle_selection(prompt_bufnr)
                end)
                map("i", "<Esc>", cancel_selection)
                map("n", "q", cancel_selection)
                map("i", "<C-c>", cancel_selection)
                map("n", "<C-c>", cancel_selection)
                return true
            end,
        }):find()
    end)

    if not ok then
        vim.notify("kra-memory picker failed: " .. tostring(err), vim.log.levels.ERROR)
        pcall(vim.fn.rpcnotify, channel_id, "memory_picker_selection", nil)
    end
end

--- Open a single memory entry in a scratch buffer for editing.
--- Buffer keymaps: <leader>w save, <leader>d delete,
--- <leader>r resolve, <leader>x dismiss, <leader>o reopen (revisits only), q close.
function M.open_memory_buffer(item, view)
    if not item or not item.id then
        return
    end
    view = view or "all"

    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_option(buf, "buftype", "acwrite")
    vim.api.nvim_buf_set_option(buf, "bufhidden", "wipe")
    vim.api.nvim_buf_set_option(buf, "filetype", "markdown")
    vim.api.nvim_buf_set_name(buf, "kra-memory://" .. item.id)

    local header = {
        "---",
        "id: " .. (item.id or ""),
        "kind: " .. (item.kind or ""),
        "status: " .. (item.status or ""),
        "created: " .. os.date("%Y-%m-%d %H:%M:%S", math.floor((item.createdAt or 0) / 1000)),
        "paths: " .. table.concat(item.paths or {}, ","),
        "title: " .. (item.title or ""),
        "tags: " .. table.concat(item.tags or {}, ","),
        "---",
        "",
    }
    local lines = {}
    for _, h in ipairs(header) do
        table.insert(lines, h)
    end
    for line in (item.body or ""):gmatch("([^\n]*)\n?") do
        table.insert(lines, line)
    end
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(buf, "modified", false)

    vim.cmd("tabnew")
    vim.api.nvim_win_set_buf(0, buf)

    local function parse_buffer()
        local all = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
        local title, tags = item.title or "", table.concat(item.tags or {}, ",")
        local body_start = 1
        if all[1] == "---" then
            for i = 2, #all do
                if all[i] == "---" then
                    body_start = i + 1
                    if all[body_start] == "" then
                        body_start = body_start + 1
                    end
                    break
                end
                local k, v = all[i]:match("^(%w+):%s*(.*)$")
                if k == "title" then
                    title = v
                elseif k == "tags" then
                    tags = v
                end
            end
        end
        local body_lines = {}
        for i = body_start, #all do
            table.insert(body_lines, all[i])
        end
        return title, tags, table.concat(body_lines, "\n")
    end

    local function save()
        local title, tags, body = parse_buffer()
        rpc.send_action("edit_memory", {
            id = item.id,
            title = title,
            body = body,
            tags = tags,
            view = view,
        })
        vim.api.nvim_buf_set_option(buf, "modified", false)
        vim.notify("Memory saved", vim.log.levels.INFO, { title = "kra-memory" })
        vim.cmd("bwipeout!")
    end

    local opts = { buffer = buf, silent = true, nowait = true }
    vim.keymap.set("n", "<leader>w", save, vim.tbl_extend("force", opts, { desc = "Save memory edits" }))
    vim.api.nvim_create_autocmd("BufWriteCmd", { buffer = buf, callback = save })

    vim.keymap.set("n", "<leader>d", function()
        vim.ui.select({ "Yes, delete", "No, cancel" }, {
            prompt = "Delete \"" .. (item.title or "?") .. "\"?",
        }, function(choice)
            if choice == "Yes, delete" then
                rpc.send_action("delete_memory", { id = item.id, view = view })
                vim.cmd("bwipeout!")
            end
        end)
    end, vim.tbl_extend("force", opts, { desc = "Delete memory" }))

    vim.keymap.set("n", "<leader>r", function()
        if item.kind ~= "revisit" then
            vim.notify("Resolve only applies to revisits", vim.log.levels.WARN, { title = "kra-memory" })
            return
        end
        vim.ui.input({ prompt = "Resolution note (optional): " }, function(note)
            rpc.send_action("set_memory_status", {
                id = item.id,
                status = "resolved",
                resolution = note or "",
                view = view,
            })
            vim.cmd("bwipeout!")
        end)
    end, vim.tbl_extend("force", opts, { desc = "Resolve revisit" }))

    vim.keymap.set("n", "<leader>x", function()
        if item.kind ~= "revisit" then
            vim.notify("Dismiss only applies to revisits", vim.log.levels.WARN, { title = "kra-memory" })
            return
        end
        vim.ui.input({ prompt = "Reason for dismissal (optional): " }, function(note)
            rpc.send_action("set_memory_status", {
                id = item.id,
                status = "dismissed",
                resolution = note or "",
                view = view,
            })
            vim.cmd("bwipeout!")
        end)
    end, vim.tbl_extend("force", opts, { desc = "Dismiss revisit" }))

    vim.keymap.set("n", "<leader>o", function()
        if item.kind ~= "revisit" then
            vim.notify("Reopen only applies to revisits", vim.log.levels.WARN, { title = "kra-memory" })
            return
        end
        rpc.send_action("set_memory_status", {
            id = item.id,
            status = "open",
            resolution = "",
            view = view,
        })
        vim.cmd("bwipeout!")
    end, vim.tbl_extend("force", opts, { desc = "Reopen revisit" }))

    vim.keymap.set("n", "q", "<Cmd>bwipeout!<CR>", vim.tbl_extend("force", opts, { desc = "Close memory buffer" }))
end

return M
