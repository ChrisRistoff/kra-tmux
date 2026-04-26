local M = {}

local popups = require("kra_agent_popups")
local diff = require("kra_agent_diff")

local spinner_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local uv = vim.uv or vim.loop

local state = {
    active_entry_index = nil,
    body = "Ready",
    history = {},
    icon = "󰚩",
    level = vim.log.levels.INFO,
    notification = nil,
    popups_hidden = false,
    spinner_index = 1,
    spinning = false,
    statusline = "Ready",
    timer = nil,
    title = "Copilot Agent",
}

local function redraw_statusline()
    pcall(vim.cmd, "redrawstatus")
end

local function current_icon()
    if state.spinning then
        return spinner_frames[state.spinner_index]
    end
    return state.icon
end

local function render_notification(timeout)
    if state.popups_hidden then
        return
    end
    state.notification = vim.notify(state.body or "", state.level, {
        title = state.title,
        replace = state.notification,
        timeout = timeout,
        hide_from_history = false,
        icon = current_icon(),
    })
    redraw_statusline()
end

local function dismiss_notification()
    if state.notification then
        pcall(function()
            require("notify").dismiss({ pending = false, silent = true })
        end)
        state.notification = nil
    end
end

local function stop_spinner()
    if not state.timer then
        return
    end
    state.timer:stop()
    state.timer:close()
    state.timer = nil
end

local function start_spinner()
    if state.timer then
        return
    end
    state.timer = uv.new_timer()
    state.timer:start(
        0,
        120,
        vim.schedule_wrap(function()
            state.spinner_index = (state.spinner_index % #spinner_frames) + 1
            render_notification(false)
        end)
    )
end

local function upsert_history(tool_name, details, args_json)
    local timestamp = os.date("%H:%M:%S")

    if state.active_entry_index and state.history[state.active_entry_index] then
        local entry = state.history[state.active_entry_index]
        entry.details = details
        entry.updated_at = timestamp
        return entry
    end

    local entry = {
        args_json = args_json or "",
        details = details,
        started_at = timestamp,
        status = "running",
        title = tool_name,
        updated_at = timestamp,
    }
    table.insert(state.history, entry)
    state.active_entry_index = #state.history
    return entry
end

local function complete_history(tool_name, details, success)
    local entry
    if state.active_entry_index and state.history[state.active_entry_index] then
        entry = state.history[state.active_entry_index]
    else
        entry = upsert_history(tool_name, details)
    end

    entry.title = tool_name
    entry.result = details
    entry.details = details
    entry.status = success and "done" or "failed"
    entry.updated_at = os.date("%H:%M:%S")
    state.active_entry_index = nil
end

local function set_state(opts)
    state.title = opts.title or "Copilot Agent"
    state.body = opts.body or state.body
    state.icon = opts.icon or state.icon
    state.level = opts.level or vim.log.levels.INFO
    state.statusline = opts.statusline or state.statusline
    state.spinner_index = 1
    state.spinning = opts.spinning or false

    if state.spinning then
        start_spinner()
        render_notification(false)
        return
    end

    stop_spinner()
    render_notification(opts.timeout or 3000)
end

-- Read-only viewer for a single tool history entry:
--   LEFT  pane = args JSON (as sent by the AI)
--   RIGHT pane = result / output of the tool
-- `q` closes the tab; <Tab> / <S-Tab> swap focus between panes.
local function open_history_view(entry)
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local view_tab = vim.api.nvim_get_current_tabpage()

    local args_text = (entry.args_json and entry.args_json ~= "") and entry.args_json or "{}"
    local result_text = entry.result or entry.details or "(no result recorded)"

    -- LEFT: args JSON
    local left_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(left_buf, 0, -1, false, vim.split(args_text, "\n", { plain = true }))
    vim.bo[left_buf].buftype = "nofile"
    vim.bo[left_buf].bufhidden = "wipe"
    vim.bo[left_buf].swapfile = false
    vim.bo[left_buf].filetype = "json"
    vim.bo[left_buf].modifiable = false
    vim.bo[left_buf].modified = false
    local left_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(left_win, left_buf)
    vim.wo[left_win].number = true
    vim.wo[left_win].wrap = false
    vim.wo[left_win].winbar = string.format(" 󰘦 ARGS  %s  [%s] ", entry.title or "tool", entry.status or "?")

    -- RIGHT: result
    vim.cmd("vsplit")
    local right_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(right_buf, 0, -1, false, vim.split(result_text, "\n", { plain = true }))
    vim.bo[right_buf].buftype = "nofile"
    vim.bo[right_buf].bufhidden = "wipe"
    vim.bo[right_buf].swapfile = false
    vim.bo[right_buf].modifiable = false
    vim.bo[right_buf].modified = false
    local right_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(right_win, right_buf)
    vim.wo[right_win].number = true
    vim.wo[right_win].wrap = true
    vim.wo[right_win].winbar = string.format(
        " 󰊕 RESULT  %s  ·  %s → %s ",
        entry.title or "tool",
        entry.started_at or "",
        entry.updated_at or ""
    )

    local function close_view()
        if vim.api.nvim_tabpage_is_valid(view_tab) then
            vim.cmd("tabclose")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local base = { silent = true, nowait = true }
    for _, buf in ipairs({ left_buf, right_buf }) do
        local o = vim.tbl_extend("force", base, { buffer = buf })
        vim.keymap.set("n", "q", close_view, vim.tbl_extend("force", o, { desc = "Close tool view" }))
        vim.keymap.set("n", "<Tab>", "<C-w>w", vim.tbl_extend("force", o, { desc = "Next pane" }))
        vim.keymap.set("n", "<S-Tab>", "<C-w>W", vim.tbl_extend("force", o, { desc = "Prev pane" }))
    end

    vim.api.nvim_set_current_win(left_win)
end

-- ── Public API ────────────────────────────────────────────────────────────────

function M.request_user_input(channel_id, question, choices, allow_freeform)
    popups.request_user_input(channel_id, question, choices, allow_freeform)
end

function M.request_permission(channel_id, payload)
    popups.request_permission(channel_id, payload)
end

function M.start_turn(model)
    set_state({
        body = string.format("Thinking with %s", model),
        icon = "",
        spinning = true,
        statusline = string.format("Thinking · %s", model),
    })
end

function M.start_tool(tool_name, details, args_json)
    upsert_history(tool_name, details, args_json)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = details,
        icon = "󱁤",
        spinning = true,
        statusline = string.format("Tool · %s", tool_name),
    })
end

function M.update_tool(tool_name, details)
    upsert_history(tool_name, details)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = details,
        icon = "󱁤",
        spinning = true,
        statusline = string.format("Tool · %s", tool_name),
    })
end

function M.complete_tool(tool_name, details, success)
    complete_history(tool_name, details, success)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = string.format("%s\n\nPress <Space>h for tool history.", details),
        icon = success and "󰄬" or "󰅖",
        level = success and vim.log.levels.INFO or vim.log.levels.ERROR,
        statusline = success and string.format("Finished · %s", tool_name) or string.format("Failed · %s", tool_name),
        timeout = success and 4000 or 5000,
    })
end

function M.show_error(title, details)
    set_state({
        title = title or "Copilot Agent",
        body = details or "Unknown error",
        icon = "󰅖",
        level = vim.log.levels.ERROR,
        statusline = "Error",
        timeout = 5000,
    })
end

function M.finish_turn()
    stop_spinner()
    state.spinning = false
    state.spinner_index = 1
    state.title = "Copilot Agent"
    state.body = "Ready"
    state.icon = "󰚩"
    state.level = vim.log.levels.INFO
    state.statusline = "Ready"
    render_notification(3000)
    redraw_statusline()
end

function M.ready_for_next_prompt()
    stop_spinner()
    state.spinning = false
    state.spinner_index = 1
    state.icon = "󰚩"
    state.level = vim.log.levels.INFO
    state.statusline = "Ready"
    render_notification(3000)
    redraw_statusline()
end

function M.stop_turn(message)
    set_state({
        body = message or "Stopped current turn",
        icon = "󰜺",
        level = vim.log.levels.WARN,
        statusline = "Stopped",
        timeout = 2500,
    })
end

function M.statusline()
    return string.format("%s %s", current_icon(), state.statusline)
end

function M.show_history()
    local ok, err = pcall(function()
        local pickers = require("telescope.pickers")
        local finders = require("telescope.finders")
        local previewers = require("telescope.previewers")
        local conf = require("telescope.config").values
        local actions = require("telescope.actions")
        local action_state = require("telescope.actions.state")

        if #state.history == 0 then
            vim.notify("No tool calls recorded yet.", vim.log.levels.INFO)
            return
        end

        local results = {}
        for index = #state.history, 1, -1 do
            table.insert(results, state.history[index])
        end

        pickers
            .new({
                layout_strategy = "horizontal",
                layout_config = { preview_width = 0.55, width = 0.95, height = 0.85 },
            }, {
                prompt_title = string.format("Agent Tool History  (%d calls)", #state.history),
                finder = finders.new_table({
                    results = results,
                    entry_maker = function(entry)
                        local icon = entry.status == "done" and "󰄬" or entry.status == "failed" and "󰅖" or "󱁤"
                        return {
                            value = entry,
                            display = string.format(
                                "%s %s · %s",
                                icon,
                                entry.title,
                                entry.updated_at or entry.started_at or ""
                            ),
                            ordinal = string.format(
                                "%s %s %s",
                                entry.title or "",
                                entry.status or "",
                                entry.details or ""
                            ),
                        }
                    end,
                }),
                previewer = previewers.new_buffer_previewer({
                    title = "Tool result",
                    define_preview = function(self, entry)
                        local item = entry.value
                        local text = item.result or item.details or "(no result)"
                        vim.api.nvim_buf_set_lines(
                            self.state.bufnr,
                            0,
                            -1,
                            false,
                            vim.split(text, "\n", { plain = true })
                        )
                    end,
                }),
                sorter = conf.generic_sorter({}),
                attach_mappings = function(prompt_bufnr)
                    actions.select_default:replace(function()
                        local sel = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        if not sel then
                            return
                        end
                        open_history_view(sel.value)
                    end)
                    return true
                end,
            })
            :find()
    end)

    if not ok then
        vim.notify(string.format("Agent tool history failed: %s", tostring(err)), vim.log.levels.ERROR)
    end
end

function M.toggle_popups()
    state.popups_hidden = not state.popups_hidden
    popups.set_popups_hidden(state.popups_hidden)
    if state.popups_hidden then
        dismiss_notification()
        popups.hide_user_input_window()
        popups.hide_permission_window()
    else
        if state.spinning then
            render_notification(false)
        else
            render_notification(3000)
        end
        popups.show_user_input_window()
        popups.show_permission_window()
    end
    vim.notify(
        state.popups_hidden and "Popups hidden  (<Space>t to show)" or "Popups visible",
        vim.log.levels.INFO,
        { title = "Copilot Agent", timeout = 1500 }
    )
end

function M.show_diff_history()
    diff.open_diff_history()
end

local function send_action(action, args)
    local channel = vim.g.kra_agent_channel
    if not channel or channel == 0 then
        vim.notify('kra-memory: agent channel not registered', vim.log.levels.ERROR)
        return false
    end
    pcall(vim.fn.rpcnotify, channel, 'prompt_action', action, args or vim.empty_dict())
    return true
end

local function prompt_add_memory(view)
    vim.ui.input({ prompt = 'Memory title: ' }, function(title)
        if not title or title == '' then return end
        vim.ui.input({ prompt = 'Memory body:  ' }, function(body)
            if not body or body == '' then return end
            vim.ui.input({ prompt = 'Tags (csv, optional): ' }, function(tags)
                vim.ui.select(
                    { 'note', 'bug-fix', 'gotcha', 'decision', 'investigation', 'revisit' },
                    { prompt = 'Kind:' },
                    function(kind)
                        if not kind then return end
                        send_action('add_memory', {
                            title = title,
                            body = body,
                            tags = tags or '',
                            kind = kind,
                            view = view or 'all',
                        })
                    end
                )
            end)
        end)
    end)
end

function M.show_memory_browser(items, view)
    local ok, err = pcall(function()
        local pickers = require('telescope.pickers')
        local finders = require('telescope.finders')
        local previewers = require('telescope.previewers')
        local conf = require('telescope.config').values
        local actions = require('telescope.actions')
        local action_state = require('telescope.actions.state')

        items = items or {}
        view = view or 'all'

        local function next_view(current)
            if current == 'all' then return 'findings' end
            if current == 'findings' then return 'revisits' end
            return 'all'
        end

        local function counts(list)
            local f, r = 0, 0
            for _, it in ipairs(list) do
                if it.kind == 'revisit' then r = r + 1 else f = f + 1 end
            end
            return f, r
        end

        if #items == 0 then
            vim.notify(
                'No memories in view "' .. view .. '". Press "a" to add, <Tab> to switch view.',
                vim.log.levels.INFO,
                { title = 'kra-memory' }
            )
        end

        local f_count, r_count = counts(items)
        local title = string.format(
            'kra-memory [%s]  findings:%d revisits:%d  [<CR>:open  <Tab>:view  a:add  dd:del]',
            view, f_count, r_count
        )

        pickers
            .new({
                layout_strategy = 'horizontal',
                layout_config = { preview_width = 0.55, width = 0.95, height = 0.85 },
            }, {
                prompt_title = title,
                finder = finders.new_table({
                    results = items,
                    entry_maker = function(entry)
                        local status_icon = entry.status == 'open' and '' or '·'
                        local tags = (entry.tags and #entry.tags > 0) and (' #' .. table.concat(entry.tags, ' #')) or ''
                        return {
                            value = entry,
                            display = string.format('%s [%s] %s%s', status_icon, entry.kind, entry.title, tags),
                            ordinal = string.format('%s %s %s %s', entry.kind, entry.title, entry.body or '', table.concat(entry.tags or {}, ' ')),
                        }
                    end,
                }),
                previewer = previewers.new_buffer_previewer({
                    title = 'Memory body',
                    define_preview = function(self, entry)
                        local item = entry.value
                        local lines = {
                            string.format('id:      %s', item.id),
                            string.format('kind:    %s', item.kind),
                            string.format('status:  %s', item.status or ''),
                            string.format('tags:    %s', table.concat(item.tags or {}, ', ')),
                            string.format('paths:   %s', table.concat(item.paths or {}, ', ')),
                            string.format('created: %s', os.date('%Y-%m-%d %H:%M:%S', math.floor((item.createdAt or 0) / 1000))),
                            '',
                            '# ' .. (item.title or ''),
                            '',
                        }
                        for line in (item.body or ''):gmatch('([^\n]*)\n?') do
                            table.insert(lines, line)
                        end
                        vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false, lines)
                    end,
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

                    map('n', '<Tab>', function()
                        actions.close(prompt_bufnr)
                        send_action('browse_memory', { view = next_view(view) })
                    end)
                    map('i', '<Tab>', function()
                        actions.close(prompt_bufnr)
                        send_action('browse_memory', { view = next_view(view) })
                    end)

                    map('n', 'a', function()
                        actions.close(prompt_bufnr)
                        prompt_add_memory(view)
                    end)
                    map('i', '<C-a>', function()
                        actions.close(prompt_bufnr)
                        prompt_add_memory(view)
                    end)

                    map('n', 'dd', function()
                        local sel = action_state.get_selected_entry()
                        if not sel then return end
                        local id = sel.value.id
                        vim.ui.select({ 'Yes, delete', 'No, cancel' }, {
                            prompt = 'Delete "' .. (sel.value.title or '?') .. '"?'
                        }, function(choice)
                            if choice == 'Yes, delete' then
                                actions.close(prompt_bufnr)
                                send_action('delete_memory', { id = id, view = view })
                            end
                        end)
                    end)
                    map('n', 'D', function()
                        local sel = action_state.get_selected_entry()
                        if not sel then return end
                        local id = sel.value.id
                        actions.close(prompt_bufnr)
                        send_action('delete_memory', { id = id, view = view })
                    end)

                    return true
                end,
            })
            :find()
    end)

    if not ok then
        vim.notify('kra-memory browser failed: ' .. tostring(err), vim.log.levels.ERROR)
    end
end

--- Open a single memory entry in a scratch buffer for editing.
--- Buffer keymaps: <leader>w save, <leader>d delete,
--- <leader>r resolve, <leader>x dismiss (revisits only), q close.
function M.open_memory_buffer(item, view)
    if not item or not item.id then return end
    view = view or 'all'

    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_option(buf, 'buftype', 'acwrite')
    vim.api.nvim_buf_set_option(buf, 'bufhidden', 'wipe')
    vim.api.nvim_buf_set_option(buf, 'filetype', 'markdown')
    vim.api.nvim_buf_set_name(buf, 'kra-memory://' .. item.id)

    local header = {
        '---',
        'id: ' .. (item.id or ''),
        'kind: ' .. (item.kind or ''),
        'status: ' .. (item.status or ''),
        'created: ' .. os.date('%Y-%m-%d %H:%M:%S', math.floor((item.createdAt or 0) / 1000)),
        'paths: ' .. table.concat(item.paths or {}, ','),
        'title: ' .. (item.title or ''),
        'tags: ' .. table.concat(item.tags or {}, ','),
        '---',
        '',
    }
    local lines = {}
    for _, h in ipairs(header) do table.insert(lines, h) end
    for line in (item.body or ''):gmatch('([^\n]*)\n?') do
        table.insert(lines, line)
    end
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(buf, 'modified', false)

    vim.cmd('belowright split')
    vim.api.nvim_win_set_buf(0, buf)

    local function parse_buffer()
        local all = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
        local title, tags = item.title or '', table.concat(item.tags or {}, ',')
        local body_start = 1
        if all[1] == '---' then
            for i = 2, #all do
                if all[i] == '---' then
                    body_start = i + 1
                    if all[body_start] == '' then body_start = body_start + 1 end
                    break
                end
                local k, v = all[i]:match('^(%w+):%s*(.*)$')
                if k == 'title' then title = v
                elseif k == 'tags' then tags = v end
            end
        end
        local body_lines = {}
        for i = body_start, #all do table.insert(body_lines, all[i]) end
        return title, tags, table.concat(body_lines, '\n')
    end

    local function save()
        local title, tags, body = parse_buffer()
        send_action('edit_memory', {
            id = item.id,
            title = title,
            body = body,
            tags = tags,
            view = view,
        })
        vim.api.nvim_buf_set_option(buf, 'modified', false)
        vim.notify('Memory saved', vim.log.levels.INFO, { title = 'kra-memory' })
        vim.cmd('bwipeout!')
    end

    local opts = { buffer = buf, silent = true, nowait = true }
    vim.keymap.set('n', '<leader>w', save, vim.tbl_extend('force', opts, { desc = 'Save memory edits' }))
    vim.api.nvim_create_autocmd('BufWriteCmd', { buffer = buf, callback = save })

    vim.keymap.set('n', '<leader>d', function()
        vim.ui.select({ 'Yes, delete', 'No, cancel' }, {
            prompt = 'Delete "' .. (item.title or '?') .. '"?'
        }, function(choice)
            if choice == 'Yes, delete' then
                send_action('delete_memory', { id = item.id, view = view })
                vim.cmd('bwipeout!')
            end
        end)
    end, vim.tbl_extend('force', opts, { desc = 'Delete memory' }))

    vim.keymap.set('n', '<leader>r', function()
        if item.kind ~= 'revisit' then
            vim.notify('Resolve only applies to revisits', vim.log.levels.WARN, { title = 'kra-memory' })
            return
        end
        vim.ui.input({ prompt = 'Resolution note (optional): ' }, function(note)
            send_action('set_memory_status', {
                id = item.id, status = 'resolved', resolution = note or '', view = view,
            })
            vim.cmd('bwipeout!')
        end)
    end, vim.tbl_extend('force', opts, { desc = 'Resolve revisit' }))

    vim.keymap.set('n', '<leader>x', function()
        if item.kind ~= 'revisit' then
            vim.notify('Dismiss only applies to revisits', vim.log.levels.WARN, { title = 'kra-memory' })
            return
        end
        vim.ui.input({ prompt = 'Reason for dismissal (optional): ' }, function(note)
            send_action('set_memory_status', {
                id = item.id, status = 'dismissed', resolution = note or '', view = view,
            })
            vim.cmd('bwipeout!')
        end)
    end, vim.tbl_extend('force', opts, { desc = 'Dismiss revisit' }))

    vim.keymap.set('n', 'q', '<Cmd>bwipeout!<CR>', vim.tbl_extend('force', opts, { desc = 'Close memory buffer' }))
end

return M
