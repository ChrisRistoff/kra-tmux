local M = {}

local pending_revivers = {}  -- id -> { token = {}, fn = function }
local popups_hidden = false

function M.set_hidden(hidden)
    popups_hidden = hidden and true or false
end

function M.is_hidden()
    return popups_hidden
end

function M.register_pending(id, revive_fn)
    local token = {}
    pending_revivers[id] = { token = token, fn = revive_fn }
    return token
end

function M.clear_pending(id)
    pending_revivers[id] = nil
end

function M.guard_window(id, win, token)
    if type(win) ~= "number" or not vim.api.nvim_win_is_valid(win) then
        return
    end
    vim.api.nvim_create_autocmd("WinClosed", {
        pattern = tostring(win),
        once = true,
        callback = function()
            vim.schedule(function()
                local entry = pending_revivers[id]
                if entry and entry.token == token and not popups_hidden then
                    pcall(entry.fn)
                end
            end)
        end,
    })
end

function M.guard_buffer(id, buf, token)
    if type(buf) ~= "number" or not vim.api.nvim_buf_is_valid(buf) then
        return
    end
    vim.api.nvim_create_autocmd("BufWipeout", {
        buffer = buf,
        once = true,
        callback = function()
            vim.schedule(function()
                local entry = pending_revivers[id]
                if entry and entry.token == token and not popups_hidden then
                    pcall(entry.fn)
                end
            end)
        end,
    })
end

function M.revive_all()
    for _, entry in pairs(pending_revivers) do
        pcall(entry.fn)
    end
end

return M
