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

function M.render_notification(_timeout)
    -- STATUSLINE-ONLY mode. We used to call vim.notify() here on every
    -- tool start / progress / finish, which created a fresh floating
    -- window + buffer + ~17 highlight extmarks per call. nvim-notify
    -- can't reuse the previous buffer when its timeout has already
    -- fired (replace= silently no-ops on a dead handle), so each call
    -- ended up allocating new C-side extmark btree pages that macOS's
    -- allocator never returns to the OS — the dominant ~96 MB/hour
    -- RSS climb in the embed.
    --
    -- The spinner glyph + status text are already shown in the lualine
    -- statusline (see kra_agent.ui.notify.statusline() wired into
    -- lualine_x in init.lua), so dropping the popup costs nothing
    -- visually for the running/finished status of a tool. Errors and
    -- ask-user prompts use direct vim.notify() / popup windows from
    -- elsewhere and are unaffected.
    --
    -- We still update state.title/body/statusline in the callers (see
    -- set_state in ui/init.lua) so :KraDiag and any future status
    -- inspector can read them.
    if state.popups_hidden then
        return
    end
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
            -- IMPORTANT: do NOT re-render the notification here. Each
            -- vim.notify() call (even with replace=...) builds a fresh
            -- floating window, buffer + extmarks; nvim-notify does not
            -- promptly free the replaced one and we leak ~hundreds of
            -- KB per tick. The spinner glyph is also visible in the
            -- statusline (statusline() reads current_icon()), so a
            -- redrawstatus is enough to animate it without leaking.
            M.redraw_statusline()
        end)
    )
end

function M.statusline()
    return string.format("%s %s", M.current_icon(), state.statusline)
end

return M
