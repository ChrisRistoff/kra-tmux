local M = {}

local json = require("kra_agent.util.json")
local state = require("kra_agent.ui.state")

function M.show_tool_execution_result(result_text, error_msg, title)
    local lines = {}
    if error_msg and error_msg ~= "" then
        table.insert(lines, "ERROR: " .. error_msg)
    else
        local pretty = json.pretty_via_jq(result_text or "")
        for _, l in ipairs(vim.split(pretty, "\n", { plain = true })) do
            table.insert(lines, l)
        end
    end

    -- Reuse existing popup if still open.
    if state.tool_result_win and vim.api.nvim_win_is_valid(state.tool_result_win) then
        pcall(vim.api.nvim_win_close, state.tool_result_win, true)
    end

    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    vim.bo[buf].filetype = (error_msg and error_msg ~= "") and "text" or "json"
    vim.bo[buf].modifiable = false

    local width = math.floor(vim.o.columns * 0.8)
    local height = math.floor(vim.o.lines * 0.7)
    local row = math.floor((vim.o.lines - height) / 2)
    local col = math.floor((vim.o.columns - width) / 2)
    local win = vim.api.nvim_open_win(buf, true, {
        relative = "editor",
        width = width,
        height = height,
        row = row,
        col = col,
        style = "minimal",
        border = "rounded",
        title = " Tool result: " .. tostring(title or "") .. " ",
        title_pos = "center",
    })
    vim.wo[win].number = true
    vim.wo[win].wrap = true
    state.tool_result_win = win
    state.tool_result_buf = buf

    local close = function()
        if vim.api.nvim_win_is_valid(win) then
            pcall(vim.api.nvim_win_close, win, true)
        end
        state.tool_result_win = nil
        state.tool_result_buf = nil
    end
    vim.keymap.set("n", "q", close, { buffer = buf, silent = true, nowait = true, desc = "Close result popup" })
    vim.keymap.set("n", "<leader>q", close, { buffer = buf, silent = true, nowait = true, desc = "Close result popup" })
end

return M
