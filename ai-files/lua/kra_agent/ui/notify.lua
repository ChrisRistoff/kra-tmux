local M = {}

local state = require("kra_agent.ui.state")

local spinner_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local uv = vim.uv or vim.loop

function M.redraw_statusline()
    pcall(vim.cmd, "redrawstatus")
end

function M.current_icon()
    if state.spinning then
        return spinner_frames[state.spinner_index]
    end
    return state.icon
end

function M.render_notification(timeout)
    if state.popups_hidden then
        return
    end
    state.notification = vim.notify(state.body or "", state.level, {
        title = state.title,
        replace = state.notification,
        timeout = timeout,
        hide_from_history = false,
        icon = M.current_icon(),
    })
    M.redraw_statusline()
end

function M.dismiss_notification()
    if state.notification then
        pcall(function()
            require("notify").dismiss({ pending = false, silent = true })
        end)
        state.notification = nil
    end
end

function M.stop_spinner()
    if not state.timer then
        return
    end
    state.timer:stop()
    state.timer:close()
    state.timer = nil
end

function M.start_spinner()
    if state.timer then
        return
    end
    state.timer = uv.new_timer()
    state.timer:start(
        0,
        120,
        vim.schedule_wrap(function()
            state.spinner_index = (state.spinner_index % #spinner_frames) + 1
            M.render_notification(false)
        end)
    )
end

function M.statusline()
    return string.format("%s %s", M.current_icon(), state.statusline)
end

return M
