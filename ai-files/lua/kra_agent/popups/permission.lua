local M = {}

local guard = require("kra_agent.popups.guard")
local rpc = require("kra_agent.util.rpc")
local diff = require("kra_agent.diff")
local diff_helpers = require("kra_agent.diff.helpers")

local ns = vim.api.nvim_create_namespace("kra_agent_popups")

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
        pcall(function()
            permission.popup:hide()
        end)
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
        pcall(function()
            permission.popup:show()
        end)
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
    guard.clear_pending("permission")
    close_permission()
    close_permission()
    rpc.safe_notify(channel_id, "tool_permission_decision", action, payload_json)
end

function M.request_permission(channel_id, payload)
    close_permission()

    local preview = diff_helpers.extract_write_preview(payload)
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
        local footer = preview and " <CR>/a allow · e diff review · j raw json · s family · y yolo · d deny · <Space>t hide "
            or " <CR>/a allow · e edit args · s family · y yolo · d deny · <Space>t hide "
        local popup = Popup({
            enter = true,
            focusable = true,
            position = "50%",
            relative = "editor",
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

    local _tok = guard.register_pending("permission", function()
        M.request_permission(channel_id, payload)
    end)
    guard.guard_window("permission", win, _tok)

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
            guard.clear_pending("permission")
            rpc.safe_notify(channel_id, "tool_permission_decision", action, edited_json)
        end
    end

    local function prompt_deny_reason()
        vim.ui.input({ prompt = "Deny reason (Enter = skip, Esc = cancel back): " }, function(reason)
            if reason == nil then
                vim.schedule(function()
                    if win and vim.api.nvim_win_is_valid(win) then
                        vim.api.nvim_set_current_win(win)
                    end
                end)
                return
            end
            send_permission(channel_id, "deny", reason)
        end)
    end

    local function execute_action(action_id)
        if action_id == "allow" then
            send_permission(channel_id, "allow")
        elseif action_id == "edit-diff" then
            guard.clear_pending("permission")
            close_permission()
            diff.open_write_diff_editor(channel_id, payload, make_send_fn())
        elseif action_id == "edit-json" then
            guard.clear_pending("permission")
            close_permission()
            diff.open_args_editor(channel_id, payload, make_send_fn())
        elseif action_id == "allow-family" then
            send_permission(channel_id, "allow-family")
        elseif action_id == "yolo" then
            send_permission(channel_id, "yolo")
        else
            prompt_deny_reason()
        end
    end

    local function move_selection(delta)
        selected_index = ((selected_index - 1 + delta) % #actions) + 1
        rerender()
    end

    local opts = { buffer = buf, silent = true, nowait = true }
    vim.keymap.set("n", "<CR>", function()
        execute_action(actions[selected_index].id)
    end, vim.tbl_extend("force", opts, { desc = "Run selected approval action" }))
    vim.keymap.set("n", "<Down>", function()
        move_selection(1)
    end, vim.tbl_extend("force", opts, { desc = "Next approval action" }))
    vim.keymap.set("n", "<Up>", function()
        move_selection(-1)
    end, vim.tbl_extend("force", opts, { desc = "Previous approval action" }))
    vim.keymap.set("n", "a", function()
        execute_action("allow")
    end, vim.tbl_extend("force", opts, { desc = "Approve tool once" }))
    vim.keymap.set("n", "e", function()
        execute_action(preview and "edit-diff" or "edit-json")
    end, vim.tbl_extend("force", opts, { desc = "Open approval editor" }))
    if preview then
        vim.keymap.set("n", "J", function()
            execute_action("edit-json")
        end, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
        vim.keymap.set("n", "<leader>j", function()
            execute_action("edit-json")
        end, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
    end
    vim.keymap.set("n", "s", function()
        execute_action("allow-family")
    end, vim.tbl_extend("force", opts, { desc = "Allow this tool family for session" }))
    vim.keymap.set("n", "y", function()
        execute_action("yolo")
    end, vim.tbl_extend("force", opts, { desc = "Enable YOLO mode" }))
    vim.keymap.set("n", "d", function()
        execute_action("deny")
    end, vim.tbl_extend("force", opts, { desc = "Deny tool call" }))
    vim.keymap.set("n", "q", function()
        execute_action("deny")
    end, vim.tbl_extend("force", opts, { desc = "Close and deny" }))

    if guard.is_hidden() then
        hide_permission_window()
    end
end

M.hide_permission_window = hide_permission_window
M.show_permission_window = show_permission_window

return M
