local M = {}

local state = require("kra_agent.diff.state")
local helpers = require("kra_agent.diff.helpers")
local spill = require("kra_agent.util.spill")

-- Loads the line tables that were spilled to disk by finalize_pending_diff.
-- Returns (current_lines, applied_lines, proposed_lines), each a list of
-- strings (or {} on failure). Kept local so we can swap the storage backend
-- without touching the diff-rendering code that calls it.
local function load_entry_lines(entry)
    local crlf = entry.current_crlf or false
    local current = (entry.current_sha and spill.load_lines(entry.current_sha, crlf))
        or entry.current_lines -- fallback for legacy entries
        or {}
    local applied = (entry.applied_sha and spill.load_lines(entry.applied_sha, crlf))
        or entry.applied_lines
    local proposed = (entry.proposed_sha and spill.load_lines(entry.proposed_sha, crlf))
        or entry.proposed_lines
    return current, applied, proposed
end

-- Loads the pre-session original lines for a path. Handles both the new
-- sha-ref layout and any legacy table-of-lines entries that may still be in
-- memory from before the disk-back refactor.
local function load_original_lines(path)
    local entry = state.original_by_path[path]
    if entry == nil then return nil end
    if type(entry) == "string" then
        local crlf = state.crlf_by_path[path] or false
        return spill.load_lines(entry, crlf)
    end
    -- Legacy: still a list of lines.
    return entry
end

-- Opens a focused 2-pane revert view.
-- LEFT = current on-disk content, RIGHT = pre-session original (editable).
-- <leader>a writes the RIGHT buffer to disk; q/<leader>d cancels.
local function open_revert_diff_editor(path, original_lines)
    local f = io.open(path, "rb")
    local current_content = f and f:read("*a") or ""
    if f then
        f:close()
    end
    local current_lines_disk = vim.split(current_content, "\n", { plain = true })
    for i, l in ipairs(current_lines_disk) do
        current_lines_disk[i] = (l:gsub("\r$", ""))
    end
    if current_lines_disk[#current_lines_disk] == "" then
        table.remove(current_lines_disk)
    end

    helpers.setup_diff_highlights()
    local saved_diffopt = vim.o.diffopt
    vim.o.diffopt = "internal,filler,closeoff,linematch:60"
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local diff_tab = vim.api.nvim_get_current_tabpage()
    local ft = helpers.infer_filetype(vim.fn.fnamemodify(path, ":t"))

    -- LEFT: current file content (what AI left it as), read-only reference
    local left_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(left_buf, 0, -1, false, current_lines_disk)
    vim.bo[left_buf].modifiable = false
    vim.bo[left_buf].filetype = ft
    local left_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(left_win, left_buf)
    vim.wo[left_win].winbar = " \226\172\183 CURRENT (on disk) "
    vim.wo[left_win].winhighlight =
        "DiffAdd:KraDiffAdd,DiffDelete:KraDiffDelete,DiffChange:KraDiffChange,DiffText:KraDiffText"

    -- RIGHT: original content (editable so user can do a partial revert)
    vim.cmd("vsplit")
    local right_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(right_buf, 0, -1, false, original_lines)
    vim.bo[right_buf].filetype = ft
    local right_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(right_win, right_buf)
    vim.wo[right_win].winbar = string.format(" \226\143\135 ORIGINAL  %s  (pre-session) ", path)
    vim.wo[right_win].winhighlight =
        "DiffAdd:KraDiffAdd,DiffDelete:KraDiffDelete,DiffChange:KraDiffChange,DiffText:KraDiffText"

    for _, win in ipairs({ left_win, right_win }) do
        vim.api.nvim_win_call(win, function()
            vim.cmd("diffthis")
            vim.opt_local.foldopen = vim.opt_local.foldopen - "block"
        end)
    end

    local function close_revert()
        vim.o.diffopt = saved_diffopt
        for _, win in ipairs({ left_win, right_win }) do
            if vim.api.nvim_win_is_valid(win) then
                pcall(vim.api.nvim_win_call, win, function()
                    vim.cmd("diffoff")
                end)
            end
        end
        if vim.api.nvim_tabpage_is_valid(diff_tab) then
            vim.cmd("tabclose")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local function do_revert()
        local lines = vim.api.nvim_buf_get_lines(right_buf, 0, -1, false)
        local sep = (state.crlf_by_path[path] or false) and "\r\n" or "\n"
        local content = table.concat(lines, sep)
        local file = io.open(path, "wb") -- binary: preserve chosen separator
        if file then
            file:write(content)
            file:close()
            close_revert()
            vim.notify("Reverted: " .. path, vim.log.levels.INFO, { title = "Revert" })
        else
            vim.notify("Could not write to " .. path, vim.log.levels.ERROR, { title = "Revert" })
        end
    end

    local base = { silent = true, nowait = true }
    for _, buf in ipairs({ left_buf, right_buf }) do
        local o = vim.tbl_extend("force", base, { buffer = buf })
        vim.keymap.set("n", "<leader>a", do_revert, vim.tbl_extend("force", o, { desc = "Confirm revert" }))
        vim.keymap.set("n", "<leader>d", close_revert, vim.tbl_extend("force", o, { desc = "Cancel revert" }))
        vim.keymap.set("n", "q", close_revert, vim.tbl_extend("force", o, { desc = "Cancel revert" }))
        vim.keymap.set("n", "<Tab>", "<C-w>w", vim.tbl_extend("force", o, { desc = "Next pane" }))
        vim.keymap.set("n", "<S-Tab>", "<C-w>W", vim.tbl_extend("force", o, { desc = "Prev pane" }))
        vim.keymap.set("n", "zm", "zM", vim.tbl_extend("force", o, { desc = "Refold all" }))
    end

    vim.api.nvim_set_current_win(right_win)
    pcall(vim.cmd, "normal! ]c")
end

-- Opens a read-only 2-pane diff for a historical entry using the already-
-- captured lines (temp files are gone by this point).
-- LEFT = what the file looked like before the AI write.
-- RIGHT = what the AI proposed to write.
local function open_history_diff_view(entry)
    helpers.setup_diff_highlights()
    local ft = helpers.infer_filetype(vim.fn.fnamemodify(entry.path or "", ":t"))
    local saved_diffopt = vim.o.diffopt
    vim.o.diffopt = "internal,filler,closeoff,linematch:60"
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local diff_tab = vim.api.nvim_get_current_tabpage()

    -- LEFT: before (read-only reference)
    local cur_lines, app_lines, prop_lines = load_entry_lines(entry)
    local left_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(left_buf, 0, -1, false, cur_lines or {})
    vim.bo[left_buf].modifiable = false
    vim.bo[left_buf].filetype = ft
    local left_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(left_win, left_buf)
    vim.wo[left_win].winbar = string.format(" \226\172\183 BEFORE  %s ", entry.path or "")
    vim.wo[left_win].winhighlight =
        "DiffAdd:KraDiffAdd,DiffDelete:KraDiffDelete,DiffChange:KraDiffChange,DiffText:KraDiffText"

    -- RIGHT: proposed (editable — <leader>a to apply to disk)
    vim.cmd("vsplit")
    local right_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(right_buf, 0, -1, false, app_lines or prop_lines or {})
    vim.bo[right_buf].buftype = "nofile"
    vim.bo[right_buf].bufhidden = "wipe"
    vim.bo[right_buf].swapfile = false
    vim.bo[right_buf].filetype = ft
    vim.bo[right_buf].modifiable = true
    vim.bo[right_buf].modified = false
    local right_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(right_win, right_buf)
    vim.wo[right_win].winbar = string.format(
        " \239\164\164 PROPOSED  %s  #%d  +%d -%d  [%s]  \226\156\143 <Space>a to apply ",
        entry.path or "",
        entry.seq or 0,
        entry.added or 0,
        entry.removed or 0,
        entry.status or "?"
    )
    vim.wo[right_win].winhighlight =
        "DiffAdd:KraDiffAdd,DiffDelete:KraDiffDelete,DiffChange:KraDiffChange,DiffText:KraDiffText"

    for _, win in ipairs({ left_win, right_win }) do
        vim.api.nvim_win_call(win, function()
            vim.cmd("diffthis")
            vim.opt_local.foldopen = vim.opt_local.foldopen - "block"
        end)
    end

    local function close_view()
        vim.o.diffopt = saved_diffopt
        for _, win in ipairs({ left_win, right_win }) do
            if vim.api.nvim_win_is_valid(win) then
                pcall(vim.api.nvim_win_call, win, function()
                    vim.cmd("diffoff")
                end)
            end
        end
        if vim.api.nvim_tabpage_is_valid(diff_tab) then
            vim.cmd("tabclose")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local function apply_to_disk()
        local path = entry.path
        if not path or path == "" then
            vim.notify("No file path on this history entry.", vim.log.levels.ERROR, { title = "Apply" })
            return
        end
        local lines = vim.api.nvim_buf_get_lines(right_buf, 0, -1, false)
        local sep = (state.crlf_by_path[path] or false) and "\r\n" or "\n"
        local content = table.concat(lines, sep)
        local file = io.open(path, "wb") -- binary: preserve chosen separator
        if file then
            file:write(content)
            file:close()
            close_view()
            vim.notify("Applied: " .. path, vim.log.levels.INFO, { title = "History Apply" })
        else
            vim.notify("Could not write to " .. path, vim.log.levels.ERROR, { title = "History Apply" })
        end
    end

    local base = { silent = true, nowait = true }
    for _, buf in ipairs({ left_buf, right_buf }) do
        local o = vim.tbl_extend("force", base, { buffer = buf })
        vim.keymap.set("n", "q", close_view, vim.tbl_extend("force", o, { desc = "Close history view" }))
        vim.keymap.set("n", "<leader>d", close_view, vim.tbl_extend("force", o, { desc = "Close history view" }))
        vim.keymap.set("n", "<leader>a", apply_to_disk, vim.tbl_extend("force", o, { desc = "Apply proposed to disk" }))
        vim.keymap.set("n", "<Tab>", "<C-w>w", vim.tbl_extend("force", o, { desc = "Next pane" }))
        vim.keymap.set("n", "<S-Tab>", "<C-w>W", vim.tbl_extend("force", o, { desc = "Prev pane" }))
        vim.keymap.set("n", "zm", "zM", vim.tbl_extend("force", o, { desc = "Refold all" }))
    end

    vim.api.nvim_set_current_win(right_win)
    pcall(vim.cmd, "normal! ]c")
end

-- Called by the TS layer once a tool whose write was approved (possibly with
-- user edits) finishes executing. On success we commit the queued entry to
-- diff_history; on failure we silently discard it so the picker never shows
-- writes that the underlying tool rejected.
function M.finalize_pending_diff(success)
    local entry = table.remove(state.pending_diff_entries, 1)
    if not entry then
        return
    end
    if not success then
        return
    end
    entry.seq = #state.diff_history + 1
    entry.status = "approved"
    local crlf = entry.current_crlf or false
    -- Spill the heavy line tables to disk. We keep only sha refs in heap so
    -- the history never grows past O(entries) booleans + sha strings, even
    -- across hundreds of large-file diffs in a single session.
    if entry.current_lines then
        entry.current_sha = spill.spill_lines(entry.current_lines, crlf)
        entry.current_lines = nil
    end
    if entry.applied_lines then
        entry.applied_sha = spill.spill_lines(entry.applied_lines, crlf)
        entry.applied_lines = nil
    end
    if entry.proposed_lines then
        entry.proposed_sha = spill.spill_lines(entry.proposed_lines, crlf)
        entry.proposed_lines = nil
    end
    if not state.original_by_path[entry.path] then
        -- Reuse the same on-disk blob (sha is content-addressed, dedup is free).
        state.original_by_path[entry.path] = entry.current_sha
        state.crlf_by_path[entry.path] = entry.current_crlf
    end
    table.insert(state.diff_history, entry)
end

-- Opens a Telescope picker listing every write diff opened this session.
-- Each entry is numbered (#1 = first, #N = latest). ORIG entries at the
-- bottom allow reverting a file to its pre-session baseline.
function M.open_diff_history()
    local ok, pickers = pcall(require, "telescope.pickers")
    if not ok then
        vim.notify(
            "Telescope is required for the diff history picker.",
            vim.log.levels.WARN,
            { title = "Diff History" }
        )
        return
    end

    if #state.diff_history == 0 then
        vim.notify("No write diffs recorded this session.", vim.log.levels.INFO, { title = "Diff History" })
        return
    end

    local finders = require("telescope.finders")
    local previewers = require("telescope.previewers")
    local conf = require("telescope.config").values
    local actions = require("telescope.actions")
    local action_state = require("telescope.actions.state")

    -- Build results: newest diff first, then one ORIG entry per unique path.
    local results = {}
    for i = #state.diff_history, 1, -1 do
        table.insert(results, { kind = "diff", entry = state.diff_history[i] })
    end
    local seen = {}
    for _, e in ipairs(state.diff_history) do
        if not seen[e.path] then
            seen[e.path] = true
            table.insert(results, {
                kind = "original",
                path = e.path,
            })
        end
    end

    local status_icon = { pending = "\239\164\164", approved = "\239\144\172", denied = "\239\144\150" }

    pickers
        .new({}, {
            prompt_title = string.format("Session Diff History  (%d diffs)", #state.diff_history),
            finder = finders.new_table({
                results = results,
                entry_maker = function(item)
                    local label
                    if item.kind == "original" then
                        label = string.format("    \226\134\186 ORIG  %-42s  (pre-session baseline)", item.path)
                    else
                        local e = item.entry
                        local icon = status_icon[e.status] or "\239\164\164"
                        label = string.format(
                            "#%-3d %s  %-40s  +%d -%d  (%s)  [%s]",
                            e.seq,
                            icon,
                            e.path,
                            e.added,
                            e.removed,
                            e.timestamp,
                            e.status
                        )
                    end
                    return { value = item, display = label, ordinal = label }
                end,
            }),
            previewer = previewers.new_buffer_previewer({
                title = "Diff Preview",
                define_preview = function(self, sel_entry)
                    local item = sel_entry.value
                    if item.kind == "original" then
                        vim.api.nvim_buf_set_lines(
                            self.state.bufnr,
                            0,
                            -1,
                            false,
                            load_original_lines(item.path) or { "(no content recorded)" }
                        )
                        return
                    end
                    local h = item.entry
                    local cur_lines, app_lines, prop_lines = load_entry_lines(h)
                    local a_lines, b_lines = cur_lines, app_lines or prop_lines

                    local hunks = vim.diff(
                        table.concat(a_lines, "\n") .. "\n",
                        table.concat(b_lines, "\n") .. "\n",
                        { result_type = "indices" }
                    ) or {}

                    local sep = " │ "
                    local total_w = (self.state.winid and vim.api.nvim_win_is_valid(self.state.winid))
                            and vim.api.nvim_win_get_width(self.state.winid)
                        or 80
                    local half = math.max(10, math.floor((total_w - vim.fn.strdisplaywidth(sep)) / 2))

                    local function pad(s, w)
                        s = s or ""
                        s = s:gsub("\t", "    ")
                        local dw = vim.fn.strdisplaywidth(s)
                        if dw > w then
                            while dw > w - 1 do
                                s = s:sub(1, -2)
                                dw = vim.fn.strdisplaywidth(s)
                            end
                            s = s .. "…"
                            dw = vim.fn.strdisplaywidth(s)
                        end
                        return s .. string.rep(" ", w - dw)
                    end

                    local rows = {}
                    for _, hunk in ipairs(hunks) do
                        local a_start, a_count, b_start, b_count = hunk[1], hunk[2], hunk[3], hunk[4]
                        local n = math.max(a_count, b_count)
                        for k = 0, n - 1 do
                            local left = (k < a_count) and a_lines[a_start + k] or ""
                            local right = (k < b_count) and b_lines[b_start + k] or ""
                            local left_hl = (k < a_count) and "DiffDelete" or nil
                            local right_hl = (k < b_count) and "DiffAdd" or nil
                            table.insert(rows, { pad(left, half) .. sep .. pad(right, half), left_hl, right_hl })
                        end
                    end
                    if #rows == 0 then
                        rows = { { "(no differences)", nil, nil } }
                    end

                    local text = vim.tbl_map(function(r)
                        return r[1]
                    end, rows)
                    vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false, text)
                    local left_byte_end = #pad("", half)
                    local right_byte_start = left_byte_end + #sep
                    for idx, r in ipairs(rows) do
                        if r[2] then
                            vim.api.nvim_buf_add_highlight(self.state.bufnr, -1, r[2], idx - 1, 0, left_byte_end)
                        end
                        if r[3] then
                            vim.api.nvim_buf_add_highlight(self.state.bufnr, -1, r[3], idx - 1, right_byte_start, -1)
                        end
                    end
                end,
            }),
            sorter = conf.generic_sorter({}),
            attach_mappings = function(prompt_bufnr)
                actions.select_default:replace(function()
                    local sel = action_state.get_selected_entry()
                    actions.close(prompt_bufnr)
                    if sel then
                        local item = sel.value
                        if item.kind == "original" then
                            local orig = load_original_lines(item.path)
                            if orig then
                                open_revert_diff_editor(item.path, orig)
                            end
                        else
                            open_history_diff_view(item.entry)
                        end
                    end
                end)
                return true
            end,
        })
        :find()
end

return M
