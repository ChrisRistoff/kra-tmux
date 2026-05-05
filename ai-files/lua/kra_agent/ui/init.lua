local M = {}

local state = require("kra_agent.ui.state")
local notify = require("kra_agent.ui.notify")
local history = require("kra_agent.ui.history")
local memory = require("kra_agent.ui.memory")
local tool_result = require("kra_agent.ui.tool_result")
local index_progress = require("kra_agent.ui.index_progress")
local popups = require("kra_agent.popups")
local diff = require("kra_agent.diff")

local function set_state(opts)
    state.title = opts.title or "Copilot Agent"
    state.body = opts.body or state.body
    state.icon = opts.icon or state.icon
    state.level = opts.level or vim.log.levels.INFO
    state.statusline = opts.statusline or state.statusline
    state.spinner_index = 1
    state.spinning = opts.spinning or false

    if state.spinning then
        notify.start_spinner()
        notify.render_notification(false)
        return
    end

    notify.stop_spinner()
    -- A spinning notification was rendered with timeout=false (persistent).
    -- nvim-notify won't re-arm the timer when we replace it with a finite
    -- timeout, so dismiss the persistent handle first and render a fresh one.
    notify.dismiss_notification()
    notify.render_notification(opts.timeout or 3000)
end

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

function M.start_tool(tool_name, details, args_json, tool_call_id)
    history.upsert_history(tool_name, details, args_json, tool_call_id)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = details,
        icon = "󱁤",
        spinning = true,
        statusline = string.format("Tool · %s", tool_name),
    })
end

function M.update_tool(tool_name, details, tool_call_id)
    history.upsert_history(tool_name, details, nil, tool_call_id)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = details,
        icon = "󱁤",
        spinning = true,
        statusline = string.format("Tool · %s", tool_name),
    })
end

function M.complete_tool(tool_name, details, success, full_result, tool_call_id)
    history.complete_history(tool_name, details, success, full_result, tool_call_id)
    set_state({
        title = string.format("Tool · %s", tool_name),
        body = string.format("%s\n\nPress <Space>h for tool history.", details),
        icon = success and "󰄬" or "󰅖",
        level = success and vim.log.levels.INFO or vim.log.levels.ERROR,
        statusline = success and string.format("Finished · %s", tool_name)
            or string.format("Failed · %s", tool_name),
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
    notify.stop_spinner()
    state.spinning = false
    state.spinner_index = 1
    state.title = "Copilot Agent"
    state.body = "Ready"
    state.icon = "󰚩"
    state.level = vim.log.levels.INFO
    state.statusline = "Ready"
    notify.render_notification(3000)
    notify.redraw_statusline()
end

function M.ready_for_next_prompt()
    notify.stop_spinner()
    state.spinning = false
    state.spinner_index = 1
    state.icon = "󰚩"
    state.level = vim.log.levels.INFO
    state.statusline = "Ready"
    notify.render_notification(3000)
    notify.redraw_statusline()
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
    return notify.statusline()
end

function M.show_history()
    history.show_history()
end

function M.toggle_popups()
    state.popups_hidden = not state.popups_hidden
    popups.set_popups_hidden(state.popups_hidden)
    if state.popups_hidden then
        notify.dismiss_notification()
        popups.hide_user_input_window()
        popups.hide_permission_window()
        if popups.hide_freeform_input then
            popups.hide_freeform_input()
        end
    else
        if state.spinning then
            notify.render_notification(false)
        else
            notify.render_notification(3000)
        end
        popups.show_user_input_window()
        popups.show_permission_window()
        if popups.show_freeform_input then
            popups.show_freeform_input()
        end
        if popups.revive_all then
            popups.revive_all()
        end
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

function M.show_memory_browser(items, view)
    memory.show_memory_browser(items, view)
end

function M.pick_memories(channel_id, items, opts)
    memory.pick_memories(channel_id, items, opts)
end

function M.open_memory_buffer(item, view)
    memory.open_memory_buffer(item, view)
end

function M.set_executable_tools(list)
    local map = {}
    if type(list) == "table" then
        for _, t in ipairs(list) do
            if type(t) == "table" and t.title then
                map[t.title] = { server = t.server, name = t.name }
            end
        end
    end
    state.executable_tools = map
end

function M.show_tool_execution_result(result_text, error_msg, title)
    tool_result.show_tool_execution_result(result_text, error_msg, title)
end

function M.show_index_progress_modal(opts)
    index_progress.show_index_progress_modal(opts)
end

function M.append_index_progress(opts)
    index_progress.append_index_progress(opts)
end

function M.set_index_progress_total(opts)
    index_progress.set_index_progress_total(opts)
end

function M.set_index_progress_done(opts)
    index_progress.set_index_progress_done(opts)
end

function M.reopen_index_progress()
    index_progress.reopen_index_progress()
end

return M
