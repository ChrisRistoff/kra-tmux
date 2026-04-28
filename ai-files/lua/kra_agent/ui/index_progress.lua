local M = {}

local state = require("kra_agent.ui.state")
local uv = vim.uv or vim.loop

local function index_progress_render_header()
    if not state.index_progress_buf or not vim.api.nvim_buf_is_valid(state.index_progress_buf) then
        return
    end
    local total = state.index_progress_total or 0
    local done = state.index_progress_done or 0
    local pct = total > 0 and math.floor((done / total) * 100) or 0
    local line
    if state.index_progress_finished then
        line = string.format("kra-memory │ %s │ %s", state.index_progress_alias or "", state.index_progress_summary or "Done")
    else
        line = string.format(
            "kra-memory │ %s │ %d/%d (%d%%) — q/<Esc> dismisses",
            state.index_progress_alias or "",
            done,
            total,
            pct
        )
    end
    vim.bo[state.index_progress_buf].modifiable = true
    vim.api.nvim_buf_set_lines(
        state.index_progress_buf,
        0,
        2,
        false,
        { line, string.rep("─", math.max(20, #line)) }
    )
    vim.bo[state.index_progress_buf].modifiable = false
end

local function close_index_progress_modal()
    local channel = state.index_progress_channel
    if state.index_progress_win and vim.api.nvim_win_is_valid(state.index_progress_win) then
        pcall(vim.api.nvim_win_close, state.index_progress_win, true)
    end
    state.index_progress_win = nil
    if channel then
        pcall(vim.fn.rpcnotify, channel, "index_progress_dismissed")
    end
end

function M.show_index_progress_modal(opts)
    opts = opts or {}
    state.index_progress_alias = opts.alias or ""
    state.index_progress_total = tonumber(opts.total_files) or 0
    state.index_progress_done = 0
    state.index_progress_started_at = uv.now()
    state.index_progress_channel = tonumber(opts.channel_id) or state.index_progress_channel
    state.index_progress_finished = false
    state.index_progress_summary = nil

    if not state.index_progress_buf or not vim.api.nvim_buf_is_valid(state.index_progress_buf) then
        local buf = vim.api.nvim_create_buf(false, true)
        vim.bo[buf].buftype = "nofile"
        vim.bo[buf].bufhidden = "hide"
        vim.bo[buf].swapfile = false
        vim.bo[buf].filetype = "kra-index-progress"
        state.index_progress_buf = buf
        pcall(vim.api.nvim_buf_set_name, buf, "kra-index-progress")
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "", "" })
    else
        vim.bo[state.index_progress_buf].modifiable = true
        vim.api.nvim_buf_set_lines(state.index_progress_buf, 0, -1, false, { "", "" })
        vim.bo[state.index_progress_buf].modifiable = false
    end

    if not state.index_progress_win or not vim.api.nvim_win_is_valid(state.index_progress_win) then
        local width = math.floor(vim.o.columns * 0.7)
        local height = math.floor(vim.o.lines * 0.7)
        local row = math.floor((vim.o.lines - height) / 2)
        local col = math.floor((vim.o.columns - width) / 2)
        state.index_progress_win = vim.api.nvim_open_win(state.index_progress_buf, true, {
            relative = "editor",
            width = width,
            height = height,
            row = row,
            col = col,
            style = "minimal",
            border = "rounded",
            title = " kra-memory: indexing ",
            title_pos = "center",
        })
        vim.wo[state.index_progress_win].number = false
        vim.wo[state.index_progress_win].wrap = false
        vim.wo[state.index_progress_win].cursorline = true
    end

    local buf = state.index_progress_buf
    local close = function()
        close_index_progress_modal()
    end
    vim.keymap.set("n", "q", close, { buffer = buf, silent = true, nowait = true, desc = "Dismiss index progress" })
    vim.keymap.set("n", "<Esc>", close, { buffer = buf, silent = true, nowait = true, desc = "Dismiss index progress" })

    index_progress_render_header()
end

function M.append_index_progress(opts)
    opts = opts or {}
    if opts.files_total ~= nil then
        state.index_progress_total = tonumber(opts.files_total) or state.index_progress_total
    end
    if opts.files_done ~= nil then
        state.index_progress_done = tonumber(opts.files_done) or state.index_progress_done
    end

    if not state.index_progress_buf or not vim.api.nvim_buf_is_valid(state.index_progress_buf) then
        return
    end

    local line = tostring(opts.line or "")
    vim.bo[state.index_progress_buf].modifiable = true
    vim.api.nvim_buf_set_lines(state.index_progress_buf, -1, -1, false, { line })
    vim.bo[state.index_progress_buf].modifiable = false

    if state.index_progress_win and vim.api.nvim_win_is_valid(state.index_progress_win) then
        local last = vim.api.nvim_buf_line_count(state.index_progress_buf)
        pcall(vim.api.nvim_win_set_cursor, state.index_progress_win, { last, 0 })
    end

    index_progress_render_header()
end

function M.set_index_progress_total(opts)
    opts = opts or {}
    state.index_progress_total = tonumber(opts.total_files) or state.index_progress_total
    index_progress_render_header()
end

function M.set_index_progress_done(opts)
    opts = opts or {}
    state.index_progress_finished = true
    state.index_progress_summary = tostring(opts.summary or "Done")
    if state.index_progress_total > 0 then
        state.index_progress_done = state.index_progress_total
    end
    index_progress_render_header()
end

function M.reopen_index_progress()
    if not state.index_progress_buf or not vim.api.nvim_buf_is_valid(state.index_progress_buf) then
        vim.notify("No index progress to reopen", vim.log.levels.INFO)
        return
    end
    if state.index_progress_win and vim.api.nvim_win_is_valid(state.index_progress_win) then
        vim.api.nvim_set_current_win(state.index_progress_win)
        return
    end

    local width = math.floor(vim.o.columns * 0.7)
    local height = math.floor(vim.o.lines * 0.7)
    local row = math.floor((vim.o.lines - height) / 2)
    local col = math.floor((vim.o.columns - width) / 2)
    local win = vim.api.nvim_open_win(state.index_progress_buf, true, {
        relative = "editor",
        width = width,
        height = height,
        row = row,
        col = col,
        style = "minimal",
        border = "rounded",
        title = " kra-memory: indexing ",
        title_pos = "center",
    })
    state.index_progress_win = win
    vim.wo[win].number = false
    vim.wo[win].wrap = false
    vim.wo[win].cursorline = true

    local close = function()
        close_index_progress_modal()
    end
    vim.keymap.set("n", "q", close, { buffer = state.index_progress_buf, silent = true, nowait = true })
    vim.keymap.set("n", "<Esc>", close, { buffer = state.index_progress_buf, silent = true, nowait = true })
end

return M
