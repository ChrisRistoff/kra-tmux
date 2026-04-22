local M = {}

local ns = vim.api.nvim_create_namespace("kra_agent_popups")
local diff = require("kra_agent_diff")

local popups_hidden = false

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

-- ── Permission popup ──────────────────────────────────────────────────────────

local permission = nil

local function close_permission()
    if not permission then
        return
    end

    if permission.close then
        pcall(permission.close)
    end

    if permission.win and vim.api.nvim_win_is_valid(permission.win) then
        vim.api.nvim_win_close(permission.win, true)
    end

    if permission.buf and vim.api.nvim_buf_is_valid(permission.buf) then
        pcall(vim.api.nvim_buf_delete, permission.buf, { force = true })
    end

    permission = nil
end

local function hide_permission_window()
    if not permission then
        return
    end
    if permission.buf and vim.api.nvim_buf_is_valid(permission.buf) then
        vim.bo[permission.buf].bufhidden = "hide"
    end
    if permission.popup then
        pcall(function() permission.popup:hide() end)
    elseif permission.win and vim.api.nvim_win_is_valid(permission.win) then
        vim.api.nvim_win_close(permission.win, false)
        permission.win = nil
    end
end

local function show_permission_window()
    if not permission then
        return
    end
    if permission.popup then
        pcall(function() permission.popup:show() end)
    elseif permission.buf and vim.api.nvim_buf_is_valid(permission.buf) then
        if permission.win and vim.api.nvim_win_is_valid(permission.win) then
            return
        end
        local width = permission.width or 100
        local height = permission.height or 20
        local row = math.max(1, math.floor((vim.o.lines - height) / 2) - 1)
        local col = math.floor((vim.o.columns - width) / 2)
        local payload = permission.payload or {}
        local win = vim.api.nvim_open_win(permission.buf, true, {
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
        permission.win = win
        vim.wo[win].wrap = true
        vim.wo[win].cursorline = true
        vim.wo[win].winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder"
    end
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

local function send_permission(channel_id, action, payload_json)
    close_permission()
    safe_rpcnotify(channel_id, "tool_permission_decision", action, payload_json)
end

-- ── User input popup ──────────────────────────────────────────────────────────

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

-- ── Public API ────────────────────────────────────────────────────────────────

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

    if popups_hidden then
        hide_user_input_window()
    end
end

function M.request_permission(channel_id, payload)
    close_permission()

    local preview = diff.extract_write_preview(payload)
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
        permission = {
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

        permission = {
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

    -- Build a send_fn closure to pass into the diff editors (avoids circular dependency).
    local function make_send_fn()
        return function(action, edited_json)
            safe_rpcnotify(channel_id, "tool_permission_decision", action, edited_json)
        end
    end

    local function execute_action(action_id)
        if action_id == "allow" then
            send_permission(channel_id, "allow")
        elseif action_id == "edit-diff" then
            close_permission()
            diff.open_write_diff_editor(channel_id, payload, make_send_fn())
        elseif action_id == "edit-json" then
            close_permission()
            diff.open_args_editor(channel_id, payload, make_send_fn())
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

function M.set_popups_hidden(hidden)
    popups_hidden = hidden
end

M.hide_user_input_window = hide_user_input_window
M.show_user_input_window = show_user_input_window
M.hide_permission_window = hide_permission_window
M.show_permission_window = show_permission_window

return M
