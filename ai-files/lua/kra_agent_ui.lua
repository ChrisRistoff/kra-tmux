local M = {}

local spinner_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local uv = vim.uv or vim.loop
local ns = vim.api.nvim_create_namespace("kra_agent_ui")

local state = {
    active_entry_index = nil,
    body = "Ready",
    history = {},
    icon = "󰚩",
    level = vim.log.levels.INFO,
    notification = nil,
    permission = nil,
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
    if state.popups_hidden then return end
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
        -- Use nvim-notify's dismiss API to avoid triggering noice renderer bugs
        pcall(function() require("notify").dismiss({ pending = false, silent = true }) end)
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
    state.timer:start(0, 120, vim.schedule_wrap(function()
        state.spinner_index = (state.spinner_index % #spinner_frames) + 1
        render_notification(false)
    end))
end

local function upsert_history(tool_name, details)
    local timestamp = os.date("%H:%M:%S")

    if state.active_entry_index and state.history[state.active_entry_index] then
        local entry = state.history[state.active_entry_index]
        entry.details = details
        entry.updated_at = timestamp
        return entry
    end

    local entry = {
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

local function split_text(value)
    local text = value or ""
    local lines = vim.split(text, "\n", { plain = true })

    if #lines == 0 then
        return { "" }
    end

    return lines
end

local function join_buffer_text(buf, keep_trailing_newline)
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)

    if #lines == 0 then
        return keep_trailing_newline and "\n" or ""
    end

    local text = table.concat(lines, "\n")
    if keep_trailing_newline and text:sub(-1) ~= "\n" then
        text = text .. "\n"
    end

    return text
end

local function infer_filetype(filename)
    local ok, detected = pcall(vim.filetype.match, { filename = filename })
    if ok and type(detected) == "string" then
        return detected
    end

    return ""
end

local function configure_scratch_buffer(buf, name, filetype, modifiable)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    vim.bo[buf].modifiable = true

    if name and name ~= "" then
        -- Append a unique suffix to avoid name conflicts with prior invocations
        local unique_name = string.format("%s [%d]", name, buf)
        pcall(vim.api.nvim_buf_set_name, buf, unique_name)
    end

    if filetype and filetype ~= "" then
        vim.bo[buf].filetype = filetype
    end

    vim.bo[buf].modifiable = modifiable
    vim.bo[buf].readonly = not modifiable
    vim.bo[buf].modified = false
end

local function safe_rpcnotify(channel_id, method, ...)
    if type(channel_id) ~= "number" then
        vim.notify("Tool approval could not be sent because the agent session is unavailable.", vim.log.levels.WARN, {
            title = "Tool Approval",
        })
        return false
    end

    local channel_ok = pcall(vim.api.nvim_get_chan_info, channel_id)
    if not channel_ok then
        vim.notify("The agent session closed before this approval decision could be delivered.", vim.log.levels.WARN, {
            title = "Tool Approval",
            timeout = 4000,
        })
        return false
    end

    local ok, err = pcall(vim.fn.rpcnotify, channel_id, method, ...)
    if not ok then
        vim.notify(string.format("Tool approval failed to send: %s", tostring(err)), vim.log.levels.WARN, {
            title = "Tool Approval",
            timeout = 4000,
        })
        return false
    end

    return true
end

local function close_permission()
    if not state.permission then
        return
    end

    if state.permission.close then
        pcall(state.permission.close)
    end

    if state.permission.win and vim.api.nvim_win_is_valid(state.permission.win) then
        vim.api.nvim_win_close(state.permission.win, true)
    end

    if state.permission.buf and vim.api.nvim_buf_is_valid(state.permission.buf) then
        pcall(vim.api.nvim_buf_delete, state.permission.buf, { force = true })
    end

    state.permission = nil
end

local function decode_json_string(value)
    if type(value) ~= "string" or value == "" then
        return nil
    end

    local ok, decoded = pcall(vim.json.decode, value)
    if ok then
        return decoded
    end

    return nil
end

local function pretty_json(value)
    if type(value) ~= "string" or value == "" then
        return "{}"
    end

    local ok, decoded = pcall(vim.json.decode, value)
    if not ok then
        return value
    end

    -- Handle double-encoded JSON (string wrapping a JSON object)
    if type(decoded) == "string" then
        local nested_ok, nested = pcall(vim.json.decode, decoded)
        if nested_ok and type(nested) == "table" then
            decoded = nested
        else
            return decoded
        end
    end

    if type(decoded) ~= "table" then
        return value
    end

    -- Pretty-print with 2-space indent
    local encode_ok, encoded = pcall(vim.fn.json_encode, decoded)
    if not encode_ok then
        return value
    end

    -- vim.fn.json_encode doesn't indent, so reformat via python or manual approach
    -- Use a simple recursive formatter
    local indent = 0
    local result = {}
    local in_string = false
    local escape_next = false

    for i = 1, #encoded do
        local char = encoded:sub(i, i)

        if escape_next then
            table.insert(result, char)
            escape_next = false
        elseif char == "\\" and in_string then
            table.insert(result, char)
            escape_next = true
        elseif char == '"' then
            in_string = not in_string
            table.insert(result, char)
        elseif in_string then
            table.insert(result, char)
        elseif char == "{" or char == "[" then
            indent = indent + 1
            table.insert(result, char)
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
        elseif char == "}" or char == "]" then
            indent = indent - 1
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
            table.insert(result, char)
        elseif char == "," then
            table.insert(result, char)
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
        elseif char == ":" then
            table.insert(result, char)
            table.insert(result, " ")
        elseif char ~= " " then
            table.insert(result, char)
        end
    end

    return table.concat(result)
end

local function extract_write_preview(payload)
    if not payload.hasWritePreview then
        return nil
    end

    return {
        currentPath = payload.previewCurrentPath,
        proposedPath = payload.previewProposedPath,
        displayPath = payload.previewDisplayPath or "file",
        applyStrategy = payload.previewApplyStrategy or "content-field",
        proposedEndsWithNewline = payload.previewEndsWithNewline or false,
        note = payload.previewNote,
    }
end

local function build_permission_actions(preview)
    local actions = {
        {
            id = "allow",
            key = "<CR>",
            shortcut = "a",
            label = "Approve once",
            description = "Run this tool now with the current approved arguments.",
        },
    }

    if preview then
        table.insert(actions, {
            id = "edit-diff",
            key = "e",
            shortcut = "e",
            label = "Review split diff",
            description = "Open current vs proposed file contents and edit the right pane.",
        })
        table.insert(actions, {
            id = "edit-json",
            key = "J",
            shortcut = "J",
            label = "Edit raw JSON",
            description = "Open the underlying tool arguments directly.",
        })
    else
        table.insert(actions, {
            id = "edit-json",
            key = "e",
            shortcut = "e",
            label = "Edit arguments",
            description = "Open the actual tool JSON in an editor split.",
        })
    end

    table.insert(actions, {
        id = "allow-family",
        key = "s",
        shortcut = "s",
        label = "Allow this tool family",
        description = "Skip repeated approvals for the same tool family this session.",
    })
    table.insert(actions, {
        id = "yolo",
        key = "y",
        shortcut = "y",
        label = "Enable YOLO mode",
        description = "Stop asking for tool approvals until you reset the session mode.",
    })
    table.insert(actions, {
        id = "deny",
        key = "d",
        shortcut = "d",
        label = "Deny",
        description = "Block this tool call.",
    })

    return actions
end

local function render_permission_buffer(buf, payload, preview, actions, selected_index)
    local detail_lines = vim.split(payload.details or "", "\n", { plain = true })
    local max_detail_lines = preview and 14 or 12
    local clipped_details = {}

    for index, line in ipairs(detail_lines) do
        if index > max_detail_lines then
            table.insert(clipped_details, "… open split diff / raw JSON for the full review surface.")
            break
        end
        table.insert(clipped_details, line)
    end

    local lines = {
        string.format("󰯄  %s", payload.title or "Approve tool call"),
        "",
        string.format("Tool      %s", payload.toolName or "unknown"),
        string.format("Review    %s", preview and "Split diff + raw JSON available" or "Raw JSON editor available"),
        "",
        "Details",
        "",
    }

    vim.list_extend(lines, clipped_details)
    table.insert(lines, "")
    table.insert(lines, "Actions  (use ↑/↓, then <CR>)")
    table.insert(lines, "")

    local action_start = #lines + 1
    for index, action in ipairs(actions) do
        local marker = index == selected_index and "❯" or " "
        table.insert(
            lines,
            string.format("%s [%s] %s — %s", marker, action.shortcut, action.label, action.description)
        )
    end

    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

    for index, line in ipairs(lines) do
        if index == 1 then
            vim.api.nvim_buf_add_highlight(buf, ns, "Title", index - 1, 0, -1)
        elseif line == "Details" or line:match("^Actions") then
            vim.api.nvim_buf_add_highlight(buf, ns, "Special", index - 1, 0, -1)
        elseif line:match("^Tool%s+") or line:match("^Review%s+") then
            vim.api.nvim_buf_add_highlight(buf, ns, "Identifier", index - 1, 0, 10)
        end
    end

    for index, action in ipairs(actions) do
        local line_number = action_start + index - 1
        if index == selected_index then
            vim.api.nvim_buf_add_highlight(buf, ns, "Visual", line_number - 1, 0, -1)
        end
        vim.api.nvim_buf_add_highlight(buf, ns, "String", line_number - 1, 0, 6)
        vim.api.nvim_buf_add_highlight(buf, ns, "Function", line_number - 1, 7, 7 + #action.label)
    end
end

local function send_permission(channel_id, action, payload)
    close_permission()
    safe_rpcnotify(channel_id, "tool_permission_decision", action, payload)
end

local function open_args_editor(channel_id, payload)
    local original_tab = vim.api.nvim_get_current_tabpage()
    local args_json = pretty_json(payload.argsJson)
    local info_lines = {
        string.format("# Tool arguments · %s", payload.toolName or "tool"),
        "",
        "Edits in the right pane change the actual tool call that will run if you approve it.",
        "",
        "## Shortcuts",
        "",
        "- `<Space>a` approve edited arguments",
        "- `<Space>d` deny this tool call",
        "- `q` close and deny",
        "",
    }

    for _, line in ipairs(vim.split(payload.details or "", "\n", { plain = true })) do
        table.insert(info_lines, line)
    end

    vim.cmd("tabnew")
    local info_win = vim.api.nvim_get_current_win()
    local info_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(info_win, info_buf)
    vim.api.nvim_buf_set_lines(info_buf, 0, -1, false, info_lines)
    configure_scratch_buffer(info_buf, string.format("agent-tool-%s-help.md", payload.toolName or "request"), "markdown", false)

    vim.cmd("vsplit")

    local editor_win = vim.api.nvim_get_current_win()
    local editor_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(editor_win, editor_buf)
    vim.api.nvim_buf_set_lines(editor_buf, 0, -1, false, vim.split(args_json, "\n", { plain = true }))
    configure_scratch_buffer(editor_buf, string.format("agent-tool-%s.json", payload.toolName or "request"), "json", true)
    vim.bo[editor_buf].buflisted = true
    vim.bo[editor_buf].readonly = false
    vim.bo[editor_buf].modified = false
    vim.api.nvim_buf_call(editor_buf, function()
        pcall(vim.cmd, "normal! gg=G")
    end)

    vim.wo[info_win].wrap = true
    vim.wo[info_win].number = false
    vim.wo[editor_win].wrap = false
    vim.wo[editor_win].number = true
    vim.wo[editor_win].relativenumber = true
    vim.wo[editor_win].cursorline = true
    vim.wo[info_win].winbar = "󰘦 Tool request help"
    vim.wo[editor_win].winbar = string.format("󰘦 Editing actual args · %s", payload.toolName or "tool")

    local function close_editor_tab()
        local current_tab = vim.api.nvim_get_current_tabpage()
        if vim.api.nvim_tabpage_is_valid(current_tab) then
            vim.cmd("tabclose")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local function deny()
        close_editor_tab()
        send_permission(channel_id, "deny")
    end

    local function approve()
        local text = table.concat(vim.api.nvim_buf_get_lines(editor_buf, 0, -1, false), "\n")
        local ok, decoded = pcall(vim.json.decode, text)
        if not ok or type(decoded) ~= "table" then
            vim.notify("Edited tool arguments are not valid JSON.", vim.log.levels.ERROR, {
                title = "Tool Approval",
            })
            return
        end

        close_editor_tab()
        send_permission(channel_id, "edited", vim.json.encode(decoded))
    end

    local function map_keys(buf)
        local opts = { buffer = buf, silent = true, nowait = true }
        vim.keymap.set("n", "<leader>a", approve, vim.tbl_extend("force", opts, { desc = "Approve edited tool call" }))
        vim.keymap.set("n", "<leader>d", deny, vim.tbl_extend("force", opts, { desc = "Deny edited tool call" }))
        vim.keymap.set("n", "q", deny, vim.tbl_extend("force", opts, { desc = "Cancel tool edit" }))
    end

    map_keys(info_buf)
    map_keys(editor_buf)
    vim.api.nvim_set_current_win(editor_win)

    vim.notify("Edit the actual tool JSON in the right pane, then press <Space>a to approve or <Space>d to deny.", vim.log.levels.INFO, {
        title = "Tool Approval",
        timeout = 5000,
    })
end

local function open_write_diff_editor(channel_id, payload)
    local preview = extract_write_preview(payload)
    if not preview or not preview.currentPath or not preview.proposedPath then
        open_args_editor(channel_id, payload)
        return
    end

    local filetype = infer_filetype(preview.displayPath or "")

    local function read_file_lines(file_path)
        if not file_path then return {} end
        local f = io.open(file_path, "r")
        if not f then return {} end
        local content = f:read("*a")
        f:close()
        if not content or #content == 0 then return {} end
        return vim.split(content, "\n", { plain = true })
    end

    local current_lines  = read_file_lines(preview.currentPath)
    local proposed_lines = read_file_lines(preview.proposedPath)

    if #current_lines == 0 and #proposed_lines == 0 then
        vim.notify("Both current and proposed content are empty. Falling back to raw JSON editor.", vim.log.levels.WARN, {
            title = "Diff Editor",
        })
        open_args_editor(channel_id, payload)
        return
    end

    -- ┌─────────────┬──────────────────────────────┬──────────────────────────────┐
    -- │  CURRENT    │   RESULT  (edit here)         │  AI PROPOSED  (reference)    │
    -- │  read-only  │   editable                    │  read-only                   │
    -- └─────────────┴──────────────────────────────┴──────────────────────────────┘
    -- Mirrors fugitive's 3-way merge: LOCAL | MERGED | REMOTE.
    -- On approve, the content of the middle (result) buffer is what gets written.

    -- MIDDLE: the current window becomes the editable result.
    local mid_win     = vim.api.nvim_get_current_win()
    local original_buf = vim.api.nvim_win_get_buf(mid_win)

    local proposed_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(mid_win, proposed_buf)
    vim.api.nvim_buf_set_lines(proposed_buf, 0, -1, false, proposed_lines)
    configure_scratch_buffer(proposed_buf, string.format("result:%s", preview.displayPath or "result"), filetype, true)

    -- LEFT: current file (read-only).
    vim.cmd("leftabove vsplit")
    local left_win = vim.api.nvim_get_current_win()
    local current_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(left_win, current_buf)
    vim.api.nvim_buf_set_lines(current_buf, 0, -1, false, current_lines)
    configure_scratch_buffer(current_buf, string.format("current:%s", preview.displayPath or "current"), filetype, false)

    -- Move back to middle, then open RIGHT: AI proposed (read-only reference).
    vim.api.nvim_set_current_win(mid_win)
    vim.cmd("rightbelow vsplit")
    local right_win = vim.api.nvim_get_current_win()
    local reference_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(right_win, reference_buf)
    vim.api.nvim_buf_set_lines(reference_buf, 0, -1, false, proposed_lines)
    configure_scratch_buffer(reference_buf, string.format("proposed:%s", preview.displayPath or "proposed"), filetype, false)

    -- Winbar labels.
    vim.wo[left_win].winbar  = string.format("  ← Current (read-only) · %s", preview.displayPath or "file")
    vim.wo[mid_win].winbar   = preview.note
        and string.format("  ✏ Result (edit here) · %s  ⚠ %s", preview.displayPath or "file", preview.note)
        or  string.format("  ✏ Result (edit here) · %s", preview.displayPath or "file")
    vim.wo[right_win].winbar = string.format("  AI Proposed (reference) → · %s", preview.displayPath or "file")

    for _, win in ipairs({ left_win, mid_win, right_win }) do
        vim.wo[win].wrap           = false
        vim.wo[win].number         = true
        vim.wo[win].relativenumber = true
        vim.wo[win].cursorline     = true
        vim.wo[win].signcolumn     = "yes:1"
    end

    -- Enable diff mode — unchanged sections fold automatically (like :Gvdiffsplit).
    for _, win in ipairs({ left_win, mid_win, right_win }) do
        vim.api.nvim_win_call(win, function()
            vim.cmd("diffthis")
        end)
    end

    -- Focus the editable middle pane and jump to the first changed hunk.
    vim.api.nvim_set_current_win(mid_win)
    pcall(vim.cmd, "normal! ]c")

    local function close_diff()
        for _, win in ipairs({ left_win, mid_win, right_win }) do
            if vim.api.nvim_win_is_valid(win) then
                pcall(vim.api.nvim_win_call, win, function() vim.cmd("diffoff") end)
            end
        end
        if vim.api.nvim_win_is_valid(right_win) then
            vim.api.nvim_win_close(right_win, true)
        end
        if vim.api.nvim_win_is_valid(left_win) then
            vim.api.nvim_win_close(left_win, true)
        end
        -- Restore the original chat buffer in the middle window.
        if vim.api.nvim_win_is_valid(mid_win) and vim.api.nvim_buf_is_valid(original_buf) then
            vim.api.nvim_win_set_buf(mid_win, original_buf)
            vim.api.nvim_set_current_win(mid_win)
        end
    end

    local function deny()
        close_diff()
        send_permission(channel_id, "deny")
    end

    local function approve()
        local ok, decoded = pcall(vim.json.decode, type(payload.argsJson) == "string" and payload.argsJson or "{}")
        if not ok or type(decoded) ~= "table" then
            vim.notify("The original tool arguments could not be decoded.", vim.log.levels.ERROR, {
                title = "Tool Approval",
            })
            return
        end

        -- Approved text comes from the editable MIDDLE buffer (proposed_buf).
        local current_text  = join_buffer_text(current_buf, false)
        local approved_text = join_buffer_text(proposed_buf, preview.proposedEndsWithNewline)

        if preview.applyStrategy == "edit-tool" then
            decoded.old_str = current_text
            decoded.new_str = approved_text
        else
            decoded[decoded.content and "content" or "newContent"] = approved_text
        end

        close_diff()
        send_permission(channel_id, "edited", vim.json.encode(decoded))
    end

    local function edit_json()
        close_diff()
        open_args_editor(channel_id, payload)
    end

    local function map_diff_keys(buf)
        local opts = { buffer = buf, silent = true, nowait = true }
        vim.keymap.set("n", "<leader>a", approve,   vim.tbl_extend("force", opts, { desc = "Approve result buffer" }))
        vim.keymap.set("n", "<leader>d", deny,      vim.tbl_extend("force", opts, { desc = "Deny write" }))
        vim.keymap.set("n", "<leader>j", edit_json, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
        vim.keymap.set("n", "q",         deny,      vim.tbl_extend("force", opts, { desc = "Close and deny" }))
    end

    map_diff_keys(current_buf)
    map_diff_keys(proposed_buf)
    map_diff_keys(reference_buf)

    vim.api.nvim_set_current_win(mid_win)

    vim.notify(
        "<Space>a approve  ·  <Space>d deny  ·  <Space>j raw JSON  ·  q quit\n"
            .. "]c / [c jump hunks  ·  do get hunk from neighbour  ·  dp put hunk to neighbour",
        vim.log.levels.INFO,
        { title = string.format("3-way review: %s", preview.displayPath or "file"), timeout = 7000 }
    )
end

-- User input state (separate from permission state so they don't collide).
local user_input_state = { win = nil, buf = nil, popup = nil }

local function close_user_input()
    if not user_input_state.win and not user_input_state.popup then
        return
    end

    if user_input_state.popup then
        pcall(function() user_input_state.popup:unmount() end)
    elseif user_input_state.win and vim.api.nvim_win_is_valid(user_input_state.win) then
        vim.api.nvim_win_close(user_input_state.win, true)
    end

    if user_input_state.buf and vim.api.nvim_buf_is_valid(user_input_state.buf) then
        pcall(vim.api.nvim_buf_delete, user_input_state.buf, { force = true })
    end

    user_input_state = { win = nil, buf = nil, popup = nil }
end


local function hide_user_input_window()
    if not user_input_state.popup and not (user_input_state.win and vim.api.nvim_win_is_valid(user_input_state.win)) then
        return
    end
    -- Switch bufhidden to "hide" so the buffer survives its window closing
    if user_input_state.buf and vim.api.nvim_buf_is_valid(user_input_state.buf) then
        vim.bo[user_input_state.buf].bufhidden = "hide"
    end
    if user_input_state.popup then
        pcall(function() user_input_state.popup:hide() end)
    else
        vim.api.nvim_win_close(user_input_state.win, false)
        user_input_state.win = nil
    end
end

local function show_user_input_window()
    if not user_input_state.buf or not vim.api.nvim_buf_is_valid(user_input_state.buf) then
        return
    end
    if user_input_state.popup then
        pcall(function() user_input_state.popup:show() end)
    elseif not (user_input_state.win and vim.api.nvim_win_is_valid(user_input_state.win)) then
        -- Re-open the window for the existing buffer
        local width = math.min(math.max(70, math.floor(vim.o.columns * 0.65)), 120)
        local height = math.min(math.max(8, math.floor(vim.o.lines * 0.5)), math.floor(vim.o.lines * 0.85))
        local row = math.max(1, math.floor((vim.o.lines - height) / 2) - 1)
        local col = math.floor((vim.o.columns - width) / 2)
        local win = vim.api.nvim_open_win(user_input_state.buf, true, {
            relative = "editor",
            row = row, col = col,
            width = width, height = height,
            border = "rounded",
            style = "minimal",
            title = " Agent Question ",
            title_pos = "center",
        })
        user_input_state.win = win
        vim.wo[win].wrap = true
        vim.wo[win].cursorline = true
    end
end

-- Renders the question and choices into the popup buffer.
local function render_user_input_buffer(buf, question, choices, selected_index, allow_freeform)
    local lines = {}

    for _, line in ipairs(vim.split(question or "", "\n", { plain = true })) do
        table.insert(lines, line)
    end

    table.insert(lines, "")
    table.insert(lines, "Actions  (use ↑/↓, then <CR>)")
    table.insert(lines, "")

    local action_start = #lines + 1
    local all_choices = {}

    for _, choice in ipairs(choices or {}) do
        table.insert(all_choices, choice)
    end

    if allow_freeform then
        table.insert(all_choices, "Type a custom answer…")
    end

    for index, choice in ipairs(all_choices) do
        local marker = index == selected_index and "❯" or " "
        table.insert(lines, string.format("%s %s", marker, choice))
    end

    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

    -- Highlight
    for i = 1, action_start - 1 do
        if i == 1 then
            vim.api.nvim_buf_add_highlight(buf, ns, "Title", i - 1, 0, -1)
        elseif lines[i] and lines[i]:match("^Actions") then
            vim.api.nvim_buf_add_highlight(buf, ns, "Special", i - 1, 0, -1)
        end
    end

    for i, _ in ipairs(all_choices) do
        local line_nr = action_start + i - 1
        if i == selected_index then
            vim.api.nvim_buf_add_highlight(buf, ns, "Visual", line_nr - 1, 0, -1)
        end
    end

    return all_choices
end

-- Floating popup that lets the user answer a question posed by the AI via the
-- ask_user tool.  The answer is sent back via rpcnotify so the agent can
-- continue the current turn (no extra credit cost).
function M.request_user_input(channel_id, question, choices, allow_freeform)
    close_user_input()

    choices = choices or {}
    if allow_freeform == nil then allow_freeform = true end

    local selected_index = 1

    local function send(answer, is_freeform)
        close_user_input()
        safe_rpcnotify(channel_id, "user_input_response", answer, is_freeform or false)
    end

    local function prompt_freeform(prefill)
        close_user_input()
        vim.schedule(function()
            local nui_ok, Input = pcall(require, "nui.input")
            if nui_ok then
                local input_popup = Input({
                    position = "50%",
                    size = { width = math.min(math.max(50, math.floor(vim.o.columns * 0.5)), 100) },
                    border = {
                        style = "rounded",
                        text = {
                            top = "  Type your answer ",
                            top_align = "center",
                            bottom = " <CR> submit · <Esc> cancel ",
                            bottom_align = "center",
                        },
                    },
                    win_options = { winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder" },
                }, {
                    prompt = "> ",
                    default_value = prefill or "",
                    on_submit = function(value)
                        send(value, true)
                    end,
                    on_close = function()
                        send("", true)
                    end,
                })
                input_popup:mount()
                local nui_event = require("nui.utils.autocmd").event
                input_popup:on(nui_event.BufLeave, function()
                    input_popup:unmount()
                end)
            else
                -- fallback: small floating window in insert mode
                local fbuf = vim.api.nvim_create_buf(false, true)
                local fwidth = math.min(60, vim.o.columns - 4)
                local fwin = vim.api.nvim_open_win(fbuf, true, {
                    relative = "editor",
                    row = math.floor((vim.o.lines - 3) / 2),
                    col = math.floor((vim.o.columns - fwidth) / 2),
                    width = fwidth, height = 1,
                    border = "rounded",
                    style = "minimal",
                    title = " Type your answer (Enter to submit, Esc to cancel) ",
                    title_pos = "center",
                })
                if prefill and prefill ~= "" then
                    vim.api.nvim_buf_set_lines(fbuf, 0, -1, false, { prefill })
                end
                vim.cmd("startinsert!")
                local function submit()
                    local text = vim.api.nvim_buf_get_lines(fbuf, 0, 1, false)[1] or ""
                    if vim.api.nvim_win_is_valid(fwin) then vim.api.nvim_win_close(fwin, true) end
                    pcall(vim.api.nvim_buf_delete, fbuf, { force = true })
                    send(text, true)
                end
                local function cancel()
                    if vim.api.nvim_win_is_valid(fwin) then vim.api.nvim_win_close(fwin, true) end
                    pcall(vim.api.nvim_buf_delete, fbuf, { force = true })
                    send("", true)
                end
                local fopts = { buffer = fbuf, silent = true }
                vim.keymap.set({ "i", "n" }, "<CR>",  submit, fopts)
                vim.keymap.set({ "i", "n" }, "<Esc>", cancel, fopts)
            end
        end)
    end

    local all_choices = {}
    for _, choice in ipairs(choices) do
        table.insert(all_choices, choice)
    end
    if allow_freeform then
        table.insert(all_choices, "Type a custom answer…")
    end

    local n_choices = #all_choices

    -- Compute height from actual content: question lines + 3 section lines + choices.
    local question_line_count = #vim.split(question or "", "\n", { plain = true })
    local content_lines = question_line_count + 3 + n_choices
    local width = math.min(math.max(70, math.floor(vim.o.columns * 0.65)), 120)
    local height = math.min(math.max(content_lines + 2, 8), math.floor(vim.o.lines * 0.85))
    local buf
    local win

    local popup_ok, Popup = pcall(require, "nui.popup")

    if popup_ok then
        local popup = Popup({
            enter = true,
            focusable = true,
            position = "50%",
            size = { width = width, height = height },
            border = {
                style = "rounded",
                text = {
                    top = "  Agent Question ",
                    top_align = "center",
                    bottom = " ↑/↓ navigate · <CR> select · q cancel ",
                    bottom_align = "center",
                },
            },
            win_options = {
                winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder",
                cursorline = true,
                wrap = true,
            },
        })
        popup:mount()
        buf = popup.bufnr
        win = popup.winid
        user_input_state = { buf = buf, win = win, popup = popup }
    else
        local row = math.max(1, math.floor((vim.o.lines - height) / 2) - 1)
        local col = math.floor((vim.o.columns - width) / 2)
        buf = vim.api.nvim_create_buf(false, true)
        win = vim.api.nvim_open_win(buf, true, {
            relative = "editor",
            row = row, col = col,
            width = width, height = height,
            border = "rounded",
            style = "minimal",
            title = " Agent Question ",
            title_pos = "center",
        })
        user_input_state = { buf = buf, win = win }
    end

    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "hide"
    vim.bo[buf].swapfile = false

    local function rerender()
        render_user_input_buffer(buf, question, choices, selected_index, allow_freeform)
    end

    local function move(delta)
        selected_index = ((selected_index - 1 + delta) % n_choices) + 1
        rerender()
    end

    local function confirm()
        local is_freeform_choice = allow_freeform and selected_index == n_choices
        if is_freeform_choice then
            prompt_freeform()
        else
            send(all_choices[selected_index] or "", false)
        end
    end

    rerender()

    local opts = { buffer = buf, silent = true, nowait = true }
    vim.keymap.set("n", "<CR>", confirm, vim.tbl_extend("force", opts, { desc = "Select answer" }))
    vim.keymap.set("n", "<Down>", function() move(1) end, vim.tbl_extend("force", opts, { desc = "Next choice" }))
    vim.keymap.set("n", "<Up>", function() move(-1) end, vim.tbl_extend("force", opts, { desc = "Prev choice" }))
    vim.keymap.set("n", "q", function() send("", true) end, vim.tbl_extend("force", opts, { desc = "Cancel" }))

    -- Number shortcuts for quick selection
    for i = 1, math.min(n_choices, 9) do
        local idx = i
        vim.keymap.set("n", tostring(i), function()
            selected_index = idx
            rerender()
            vim.schedule(confirm)
        end, vim.tbl_extend("force", opts, { desc = string.format("Select choice %d", i) }))
    end

    vim.wo[win].wrap = true
    vim.wo[win].cursorline = true

    if state.popups_hidden then
        hide_user_input_window()
    end
end

function M.request_permission(channel_id, payload)
    close_permission()

    local preview = extract_write_preview(payload)
    local actions = build_permission_actions(preview)
    local selected_index = 1

    local width = math.min(math.max(80, math.floor(vim.o.columns * 0.7)), 140)
    -- Compute height from actual content: 7 header lines + detail lines (capped) +
    -- optional overflow line + 3 action-section lines + one line per action.
    local detail_lines_raw = vim.split(payload.details or "", "\n", { plain = true })
    local max_dl = preview and 14 or 12
    local clipped_count = math.min(#detail_lines_raw, max_dl)
    local overflow_line = (#detail_lines_raw > max_dl) and 1 or 0
    local content_lines = 7 + clipped_count + overflow_line + 3 + #actions
    local height = math.min(math.max(content_lines + 2, 16), math.floor(vim.o.lines * 0.9))
    local buf
    local win
    local popup_ok, Popup = pcall(require, "nui.popup")

    if popup_ok then
        local footer = preview
            and " <CR>/a allow · e diff review · j raw json · s family · y yolo · d deny "
            or " <CR>/a allow · e edit args · s family · y yolo · d deny "
        local popup = Popup({
            enter = true,
            focusable = true,
            position = "50%",
            size = {
                width = width,
                height = height,
            },
            border = {
                style = "rounded",
                text = {
                    top = string.format(" %s ", payload.title or "Tool Approval"),
                    top_align = "center",
                    bottom = footer,
                    bottom_align = "center",
                },
            },
            win_options = {
                winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder",
                cursorline = true,
                wrap = true,
            },
        })

        popup:mount()
        buf = popup.bufnr
        win = popup.winid
        state.permission = {
            buf = buf,
            payload = payload,
            popup = popup,
            win = win,
            close = function()
                popup:unmount()
            end,
        }
    else
        local row = math.max(1, math.floor((vim.o.lines - height) / 2) - 1)
        local col = math.floor((vim.o.columns - width) / 2)

        buf = vim.api.nvim_create_buf(false, true)
        win = vim.api.nvim_open_win(buf, true, {
            relative = "editor",
            row = row,
            col = col,
            width = width,
            height = height,
            border = "rounded",
            style = "minimal",
            title = payload.title or "Tool Approval",
            title_pos = "center",
        })

        state.permission = {
            buf = buf,
            payload = payload,
            win = win,
        }
    end

    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    vim.bo[buf].filetype = "markdown"
    render_permission_buffer(buf, payload, preview, actions, selected_index)

    vim.wo[win].wrap = true
    vim.wo[win].cursorline = true
    vim.wo[win].winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder"

    local function rerender()
        render_permission_buffer(buf, payload, preview, actions, selected_index)
    end

    local function execute_action(action_id)
        if action_id == "allow" then
            send_permission(channel_id, "allow")
        elseif action_id == "edit-diff" then
            close_permission()
            open_write_diff_editor(channel_id, payload)
        elseif action_id == "edit-json" then
            close_permission()
            open_args_editor(channel_id, payload)
        elseif action_id == "allow-family" then
            send_permission(channel_id, "allow-family")
        elseif action_id == "yolo" then
            send_permission(channel_id, "yolo")
        else
            send_permission(channel_id, "deny")
        end
    end

    local function move_selection(delta)
        selected_index = ((selected_index - 1 + delta) % #actions) + 1
        rerender()
    end

    local opts = { buffer = buf, silent = true, nowait = true }
    vim.keymap.set("n", "<CR>", function() execute_action(actions[selected_index].id) end, vim.tbl_extend("force", opts, { desc = "Run selected approval action" }))
    vim.keymap.set("n", "<Down>", function() move_selection(1) end, vim.tbl_extend("force", opts, { desc = "Next approval action" }))
    vim.keymap.set("n", "<Up>", function() move_selection(-1) end, vim.tbl_extend("force", opts, { desc = "Previous approval action" }))
    vim.keymap.set("n", "a", function() execute_action("allow") end, vim.tbl_extend("force", opts, { desc = "Approve tool once" }))
    vim.keymap.set("n", "e", function() execute_action(preview and "edit-diff" or "edit-json") end, vim.tbl_extend("force", opts, { desc = "Open approval editor" }))
    if preview then
        vim.keymap.set("n", "J", function() execute_action("edit-json") end, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
        vim.keymap.set("n", "<leader>j", function() execute_action("edit-json") end, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
    end
    vim.keymap.set("n", "s", function() execute_action("allow-family") end, vim.tbl_extend("force", opts, { desc = "Allow this tool family for session" }))
    vim.keymap.set("n", "y", function() execute_action("yolo") end, vim.tbl_extend("force", opts, { desc = "Enable YOLO mode" }))
    vim.keymap.set("n", "d", function() execute_action("deny") end, vim.tbl_extend("force", opts, { desc = "Deny tool call" }))
    vim.keymap.set("n", "q", function() execute_action("deny") end, vim.tbl_extend("force", opts, { desc = "Close and deny" }))
end

function M.start_turn(model)
    set_state({
        body = string.format("Thinking with %s", model),
        icon = "",
        spinning = true,
        statusline = string.format("Thinking · %s", model),
    })
end

function M.start_tool(tool_name, details)
    upsert_history(tool_name, details)
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
    redraw_statusline()
end

function M.ready_for_next_prompt()
    stop_spinner()
    state.spinning = false
    state.spinner_index = 1
    state.icon = "󰚩"
    state.level = vim.log.levels.INFO
    state.statusline = "Ready"
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

        if #state.history == 0 then
            vim.notify("No tool calls recorded yet.", vim.log.levels.INFO)
            return
        end

        local results = {}
        for index = #state.history, 1, -1 do
            table.insert(results, state.history[index])
        end

        pickers.new({}, {
            prompt_title = "Agent Tool History",
            finder = finders.new_table({
                results = results,
                entry_maker = function(entry)
                    local icon = entry.status == "done" and "󰄬"
                        or entry.status == "failed" and "󰅖"
                        or "󱁤"

                    return {
                        value = entry,
                        display = string.format("%s %s · %s", icon, entry.title, entry.updated_at or entry.started_at or ""),
                        ordinal = string.format("%s %s %s", entry.title or "", entry.status or "", entry.details or ""),
                    }
                end,
            }),
            previewer = previewers.new_buffer_previewer({
                title = "Tool Details",
                define_preview = function(self, entry)
                    local item = entry.value
                    local lines = {
                        string.format("# %s", item.title or "Tool"),
                        "",
                        string.format("Status: %s", item.status or ""),
                        string.format("Started: %s", item.started_at or ""),
                        string.format("Updated: %s", item.updated_at or ""),
                        "",
                    }

                    for _, line in ipairs(vim.split(item.details or "", "\n", { plain = true })) do
                        table.insert(lines, line)
                    end

                    vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false, lines)
                    vim.bo[self.state.bufnr].filetype = "markdown"
                end,
            }),
            sorter = conf.generic_sorter({}),
        }):find()
    end)

    if not ok then
        vim.notify(string.format("Agent tool history failed: %s", tostring(err)), vim.log.levels.ERROR)
    end
end

function M.toggle_popups()
    state.popups_hidden = not state.popups_hidden
    if state.popups_hidden then
        dismiss_notification()
        hide_user_input_window()
    else
        if state.spinning then
            render_notification(false)
        else
            render_notification(3000)
        end
        show_user_input_window()
    end
    vim.notify(
        state.popups_hidden and "Popups hidden  (<Space>t to show)" or "Popups visible",
        vim.log.levels.INFO,
        { title = "Copilot Agent", timeout = 1500 }
    )
end

return M
