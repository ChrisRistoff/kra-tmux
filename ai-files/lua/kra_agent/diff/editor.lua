local M = {}

local state = require("kra_agent.diff.state")
local helpers = require("kra_agent.diff.helpers")
local guard = require("kra_agent.popups.guard")
local history = require("kra_agent.diff.history")

local ns = state.ns

-- Opens a Telescope picker listing every diff hunk; selecting one jumps to it
-- in the RESULT (middle) pane.
local function open_hunk_picker(current_lines, proposed_lines, mid_win_ref)
    local ok, pickers = pcall(require, "telescope.pickers")
    if not ok then
        vim.notify("Telescope is required for the hunk picker.", vim.log.levels.WARN, { title = "Diff Hunks" })
        return
    end

    local finders = require("telescope.finders")
    local previewers = require("telescope.previewers")
    local conf = require("telescope.config").values
    local actions = require("telescope.actions")
    local action_state = require("telescope.actions.state")

    local hunks = vim.diff(
        table.concat(current_lines, "\n") .. "\n",
        table.concat(proposed_lines, "\n") .. "\n",
        { result_type = "indices" }
    )

    if not hunks or #hunks == 0 then
        vim.notify("No differences found.", vim.log.levels.INFO, { title = "Diff Hunks" })
        return
    end

    local results = {}
    for i, h in ipairs(hunks) do
        local a_start, a_count, b_start, b_count = h[1], h[2], h[3], h[4]
        local kind
        if a_count == 0 then
            kind = string.format("+%d added at line %d", b_count, b_start)
        elseif b_count == 0 then
            kind = string.format("-%d removed at line %d", a_count, a_start)
        else
            kind = string.format("~%d\226\134\146%d changed at line %d", a_count, b_count, b_start)
        end
        table.insert(results, {
            index = i,
            label = string.format("[%d/%d] %s", i, #hunks, kind),
            a_start = a_start,
            a_count = a_count,
            b_start = b_start,
            b_count = b_count,
        })
    end

    pickers
        .new({}, {
            prompt_title = string.format("Diff Hunks  (%d total)", #hunks),
            finder = finders.new_table({
                results = results,
                entry_maker = function(entry)
                    return { value = entry, display = entry.label, ordinal = entry.label }
                end,
            }),
            previewer = previewers.new_buffer_previewer({
                title = "Hunk Preview",
                define_preview = function(self, entry)
                    local h = entry.value
                    local ctx = 3
                    local lines = {}
                    for j = math.max(1, h.a_start - ctx), h.a_start - 1 do
                        table.insert(lines, { "  " .. (current_lines[j] or ""), "Normal" })
                    end
                    for j = h.a_start, h.a_start + h.a_count - 1 do
                        table.insert(lines, { "- " .. (current_lines[j] or ""), "DiffDelete" })
                    end
                    for j = h.b_start, h.b_start + h.b_count - 1 do
                        table.insert(lines, { "+ " .. (proposed_lines[j] or ""), "DiffAdd" })
                    end
                    for j = h.b_start + h.b_count, math.min(#proposed_lines, h.b_start + h.b_count + ctx - 1) do
                        table.insert(lines, { "  " .. (proposed_lines[j] or ""), "Normal" })
                    end
                    local text = vim.tbl_map(function(l)
                        return l[1]
                    end, lines)
                    vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false, text)
                    for idx, l in ipairs(lines) do
                        vim.api.nvim_buf_add_highlight(self.state.bufnr, -1, l[2], idx - 1, 0, -1)
                    end
                end,
            }),
            sorter = conf.generic_sorter({}),
            attach_mappings = function(prompt_bufnr)
                actions.select_default:replace(function()
                    local sel = action_state.get_selected_entry()
                    actions.close(prompt_bufnr)
                    if sel and vim.api.nvim_win_is_valid(mid_win_ref) then
                        vim.api.nvim_set_current_win(mid_win_ref)
                        local target = math.max(1, sel.value.b_start)
                        pcall(vim.api.nvim_win_set_cursor, mid_win_ref, { target, 0 })
                        pcall(vim.cmd, "normal! zv")
                    end
                end)
                return true
            end,
        })
        :find()
end

-- send_fn(action, edited_args_json?) is called when the user makes a decision.
-- This decouples the editor from the permission popup's close/notify logic.
function M.open_args_editor(channel_id, payload, send_fn)
    local original_tab = vim.api.nvim_get_current_tabpage()
    local args_json = helpers.pretty_json(payload.argsJson)
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
    helpers.configure_scratch_buffer(
        info_buf,
        string.format("agent-tool-%s-help.md", payload.toolName or "request"),
        "markdown",
        false
    )

    vim.cmd("vsplit")

    local editor_win = vim.api.nvim_get_current_win()
    local editor_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(editor_win, editor_buf)
    vim.api.nvim_buf_set_lines(editor_buf, 0, -1, false, vim.split(args_json, "\n", { plain = true }))
    helpers.configure_scratch_buffer(
        editor_buf,
        string.format("agent-tool-%s.json", payload.toolName or "request"),
        "json",
        true
    )
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
        send_fn("deny")
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
        send_fn("edited", vim.json.encode(decoded))
    end

    local function map_keys(buf)
        local opts = { buffer = buf, silent = true, nowait = true }
        vim.keymap.set("n", "<leader>a", approve, vim.tbl_extend("force", opts, { desc = "Approve edited tool call" }))
        vim.keymap.set("n", "<leader>d", deny, vim.tbl_extend("force", opts, { desc = "Deny edited tool call" }))
        vim.keymap.set("n", "q", deny, vim.tbl_extend("force", opts, { desc = "Cancel tool edit" }))
    end

    map_keys(info_buf)
    map_keys(editor_buf)

    local _tok = guard.register_pending("permission", function()
        vim.schedule(function()
            local ok, popups = pcall(require, "kra_agent.popups")
            if ok and popups.request_permission then
                popups.request_permission(channel_id, payload)
            end
        end)
    end)
    guard.guard_buffer("permission", editor_buf, _tok)
    vim.api.nvim_set_current_win(editor_win)

    vim.notify(
        "Edit the actual tool JSON in the right pane, then press <Space>a to approve or <Space>d to deny.",
        vim.log.levels.INFO,
        {
            title = "Tool Approval",
            timeout = 5000,
        }
    )
end

-- send_fn(action, edited_args_json?) is called when the user makes a decision.
function M.open_write_diff_editor(channel_id, payload, send_fn)
    local preview = helpers.extract_write_preview(payload)
    if not preview or not preview.currentPath or not preview.proposedPath then
        M.open_args_editor(channel_id, payload, send_fn)
        return
    end

    local filetype = helpers.infer_filetype(preview.displayPath or "")

    local function read_file_lines(file_path)
        if not file_path then
            return {}, false
        end
        local f = io.open(file_path, "rb")
        if not f then
            return {}, false
        end
        local content = f:read("*a")
        f:close()
        if not content or #content == 0 then
            return {}, false
        end
        local has_crlf = content:find("\r\n", 1, true) ~= nil
        local lines = vim.split(content, "\n", { plain = true })
        for i, line in ipairs(lines) do
            lines[i] = line:gsub("\r$", "")
        end
        return lines, has_crlf
    end

    local current_lines, current_crlf = read_file_lines(preview.currentPath)
    local proposed_lines = read_file_lines(preview.proposedPath)

    local diff_added, diff_removed = helpers.compute_diff_stats(current_lines, proposed_lines)
    local diff_stats = string.format("+%d -%d", diff_added, diff_removed)

    -- Build a history entry, but DO NOT commit it to diff_history yet. The
    -- entry is only recorded once (a) the user approves and (b) the underlying
    -- tool actually applies the write. See finalize_pending_diff.
    local path = preview.displayPath or "unknown"
    local history_entry = {
        channel_id = channel_id,
        payload = payload,
        send_fn = send_fn,
        path = path,
        current_lines = current_lines,
        current_crlf = current_crlf,
        proposed_lines = proposed_lines,
        timestamp = os.date("%H:%M:%S"),
        status = "pending",
        added = diff_added,
        removed = diff_removed,
    }
    if #current_lines == 0 and #proposed_lines == 0 then
        vim.notify(
            "Both current and proposed content are empty. Falling back to raw JSON editor.",
            vim.log.levels.WARN,
            {
                title = "Diff Editor",
            }
        )
        M.open_args_editor(channel_id, payload, send_fn)
        return
    end

    helpers.setup_diff_highlights()

    -- Layout (opens in a dedicated tab so the original window layout is untouched):
    --
    --  ┌──────────────┬──────────────────────┬──────────────────────┐
    --  │  CURRENT     │  RESULT  (edit here) │  AI PROPOSED         │
    --  │  read-only   │  editable            │  read-only           │
    --  ├──────────────┴──────────────────────┴──────────────────────┤
    --  │  pane guide + keyboard shortcuts (persistent help strip)   │
    --  └────────────────────────────────────────────────────────────┘

    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local diff_tab = vim.api.nvim_get_current_tabpage()

    -- Better diff algorithm: histogram + indent heuristic, same as fugitive.
    local saved_diffopt = vim.o.diffopt
    vim.opt.diffopt = {
        "filler",
        "closeoff",
        "iwhite",
        "algorithm:histogram",
        "indent-heuristic",
        "linematch:60",
    }

    -- LEFT pane: current on-disk content (read-only).
    local left_win = vim.api.nvim_get_current_win()
    local current_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(left_win, current_buf)
    vim.api.nvim_buf_set_lines(current_buf, 0, -1, false, current_lines)
    helpers.configure_scratch_buffer(
        current_buf,
        string.format("current:%s", preview.displayPath or "current"),
        filetype,
        false
    )

    -- MIDDLE pane: editable result (starts as AI proposed, user can adjust).
    vim.cmd("rightbelow vsplit")
    local mid_win = vim.api.nvim_get_current_win()
    local proposed_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(mid_win, proposed_buf)
    vim.api.nvim_buf_set_lines(proposed_buf, 0, -1, false, proposed_lines)
    helpers.configure_scratch_buffer(
        proposed_buf,
        string.format("result:%s", preview.displayPath or "result"),
        filetype,
        true
    )

    -- RIGHT pane: AI proposed reference (read-only).
    vim.cmd("rightbelow vsplit")
    local right_win = vim.api.nvim_get_current_win()
    local reference_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(right_win, reference_buf)
    vim.api.nvim_buf_set_lines(reference_buf, 0, -1, false, proposed_lines)
    helpers.configure_scratch_buffer(
        reference_buf,
        string.format("proposed:%s", preview.displayPath or "proposed"),
        filetype,
        false
    )

    -- Equalise the three diff pane widths before adding the bottom strip.
    vim.cmd("wincmd =")

    local display = preview.displayPath or "file"

    -- TOP: persistent help strip — pane labels + shortcuts (replaces vim.notify).
    -- topleft split opens a full-width strip at the very top of the tab.
    vim.api.nvim_set_current_win(left_win)
    vim.cmd("topleft split")
    local help_win = vim.api.nvim_get_current_win()
    local help_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(help_win, help_buf)

    -- Center each text line within the editor width.
    local cols = math.max(40, vim.o.columns - 2)
    local function cline(text)
        local w = vim.fn.strdisplaywidth(text)
        local pad = math.max(0, math.floor((cols - w) / 2))
        return string.rep(" ", pad) .. text
    end

    local note_suffix = preview.note and string.format("  \226\154\160 %s", preview.note) or ""
    local help_lines = {
        cline(string.format("\239\162\138  3-way diff  \194\183  %s  %s%s", display, diff_stats, note_suffix)),
        "",
        cline("LEFT  CURRENT (read-only)    \226\148\130    MIDDLE  RESULT \226\156\143 (edit here)    \226\148\130    RIGHT  AI PROPOSED (ref)"),
        "",
        cline("<Space>a  approve    <Space>d  deny    <Space>j  raw JSON    <Space>h  hunks    <Space>s  session history    q  quit"),
        cline("<Tab> / <S-Tab>  switch pane    ]c / [c  jump hunks    zm  refold"),
    }
    vim.api.nvim_buf_set_lines(help_buf, 0, -1, false, help_lines)
    helpers.configure_scratch_buffer(help_buf, "diff-help", "", false)

    vim.api.nvim_win_set_height(help_win, 6)
    vim.wo[help_win].wrap = false
    vim.wo[help_win].number = false
    vim.wo[help_win].relativenumber = false
    vim.wo[help_win].cursorline = false
    vim.wo[help_win].signcolumn = "no"
    vim.wo[help_win].foldcolumn = "0"
    vim.wo[help_win].statusline = ""

    -- Highlight the help buffer.
    vim.api.nvim_buf_clear_namespace(help_buf, ns, 0, -1)
    vim.api.nvim_buf_add_highlight(help_buf, ns, "Title", 0, 0, -1)
    vim.api.nvim_buf_add_highlight(help_buf, ns, "Special", 2, 0, -1)
    vim.api.nvim_buf_add_highlight(help_buf, ns, "Comment", 4, 0, -1)
    vim.api.nvim_buf_add_highlight(help_buf, ns, "Comment", 5, 0, -1)

    -- Winbar labels on each diff pane (visible when winbar is enabled in user config).
    vim.wo[left_win].winbar = string.format(" CURRENT (read-only)  \226\148\130  %s", display)
    vim.wo[mid_win].winbar = preview.note
            and string.format(
                " RESULT \226\156\143 (edit here)  \226\148\130  %s  %s  \226\154\160 %s",
                display,
                diff_stats,
                preview.note
            )
        or string.format(" RESULT \226\156\143 (edit here)  \226\148\130  %s  %s", display, diff_stats)
    vim.wo[right_win].winbar = string.format(" AI PROPOSED (ref)  \226\148\130  %s", display)

    local diff_winhighlight =
        "DiffAdd:KraDiffAdd,DiffDelete:KraDiffDelete,DiffChange:KraDiffChange,DiffText:KraDiffText"

    for _, win in ipairs({ left_win, mid_win, right_win }) do
        vim.wo[win].wrap = false
        vim.wo[win].number = true
        vim.wo[win].relativenumber = true
        vim.wo[win].cursorline = true
        vim.wo[win].signcolumn = "yes:1"
        vim.wo[win].foldmethod = "diff"
        vim.wo[win].foldlevel = 0
        vim.wo[win].foldcolumn = "1"
        vim.wo[win].winhighlight = diff_winhighlight
    end

    -- Prevent paragraph motions ({ / }) from auto-unfolding diff context regions.
    for _, win in ipairs({ left_win, mid_win, right_win }) do
        vim.api.nvim_win_call(win, function()
            vim.opt_local.foldopen = vim.opt_local.foldopen - "block"
        end)
    end

    -- Enable diff mode — unchanged sections fold automatically.
    for _, win in ipairs({ left_win, mid_win, right_win }) do
        vim.api.nvim_win_call(win, function()
            vim.cmd("diffthis")
        end)
    end

    -- Focus the editable middle pane and jump to the first changed hunk.
    vim.api.nvim_set_current_win(mid_win)
    pcall(vim.cmd, "normal! ]c")

    local function close_diff()
        vim.opt.diffopt = saved_diffopt
        for _, win in ipairs({ left_win, mid_win, right_win }) do
            if vim.api.nvim_win_is_valid(win) then
                pcall(vim.api.nvim_win_call, win, function()
                    vim.cmd("diffoff")
                end)
            end
        end
        if vim.api.nvim_tabpage_is_valid(diff_tab) then
            -- We've already captured `approved_text` (and `current_text`)
            -- from the buffers before reaching close_diff, so any unsaved
            -- modifications in proposed_buf are irrelevant by this point.
            -- Force the close so we don't hit `E445: Other window contains
            -- changes` when the user has edited the middle pane.
            for _, buf in ipairs({ current_buf, proposed_buf, reference_buf }) do
                if buf and vim.api.nvim_buf_is_valid(buf) then
                    pcall(vim.api.nvim_set_option_value, "modified", false, { buf = buf })
                end
            end
            pcall(vim.cmd, "tabclose!")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local function deny()
        -- Denial path: never record this diff in history. The entry was built
        -- but never committed, so we just drop it on the floor.
        close_diff()
        send_fn("deny")
    end

    local function approve()
        local ok, decoded = pcall(vim.json.decode, type(payload.argsJson) == "string" and payload.argsJson or "{}")
        if not ok or type(decoded) ~= "table" then
            vim.notify("The original tool arguments could not be decoded.", vim.log.levels.ERROR, {
                title = "Tool Approval",
            })
            return
        end

        local current_text = helpers.join_buffer_text(current_buf, false)
        local approved_text = helpers.join_buffer_text(proposed_buf, preview.proposedEndsWithNewline)

        if
            preview.applyStrategy == "edit-tool"
            and type(payload.toolName) == "string"
            and (payload.toolName:match("[_:%-%.]edit$") or payload.toolName == "edit")
        then
            -- Detect whether the user actually edited the proposed buffer.
            -- We compare against the ORIGINAL AI-proposed text (proposed_lines is
            -- the unmodified version that was loaded into the middle pane).
            local original_proposed_text = table.concat(proposed_lines, "\n")
            if preview.proposedEndsWithNewline and not original_proposed_text:find("\n$") then
                original_proposed_text = original_proposed_text .. "\n"
            end

            if approved_text ~= original_proposed_text then
                -- User edited the diff: ask whether to notify the AI of the
                -- exact post-edit lines, or just tell it the change went
                -- through and to trust LSP. Send the buffer content under
                -- __userFinalContent so the TS side knows to swap in the
                -- user's text instead of the AI's proposal.
                decoded.__userFinalContent = approved_text
                -- vim.ui.select is overridden by various UI plugins
                -- (dressing.nvim, fzf-lua, telescope-ui-select, ...) and
                -- those overrides have bugs that intermittently swallow the
                -- popup or break arrow-key navigation. vim.fn.confirm is the
                -- built-in modal prompt: deterministic, no plugin in the
                -- path, supports number-key selection (which the user has
                -- confirmed works reliably even in the buggy UIs).
                local choice = vim.fn.confirm(
                    "You edited the proposed change. Notify AI of your edits?",
                    "&Notify AI: include the new lines in the tool result\n"
                        .. "&Don't notify: trust LSP if no errors",
                    1
                )
                decoded.__userEditNotify = choice == 1
                if history_entry then
                    history_entry.applied_lines = vim.split(approved_text, "\n", { plain = true })
                    table.insert(state.pending_diff_entries, history_entry)
                end
                close_diff()
                send_fn("edited", vim.json.encode(decoded))
                return
            end
            -- Plain accept (no user edits): leave decoded unchanged so the TS
            -- hook routes through the normal allow path and lets the MCP
            -- server perform its own validation + atomic write.
        elseif preview.applyStrategy == "edit-tool" then
            decoded.old_str = current_text
            decoded.new_str = approved_text
        else
            decoded[decoded.content and "content" or "newContent"] = approved_text
        end

        if history_entry then
            history_entry.applied_lines = vim.split(approved_text, "\n", { plain = true })
            -- Queue for finalization: the TS layer will call
            -- finalize_pending_diff(success) once the tool actually runs.
            -- Only successful runs get committed to diff_history.
            table.insert(state.pending_diff_entries, history_entry)
        end
        close_diff()
        send_fn("edited", vim.json.encode(decoded))
    end

    local function edit_json()
        close_diff()
        M.open_args_editor(channel_id, payload, send_fn)
    end

    local function map_diff_keys(buf)
        local opts = { buffer = buf, silent = true, nowait = true }
        vim.keymap.set("n", "<leader>a", approve, vim.tbl_extend("force", opts, { desc = "Approve result buffer" }))
        vim.keymap.set("n", "<leader>d", deny, vim.tbl_extend("force", opts, { desc = "Deny write" }))
        vim.keymap.set("n", "<leader>j", edit_json, vim.tbl_extend("force", opts, { desc = "Edit raw tool JSON" }))
        vim.keymap.set("n", "q", deny, vim.tbl_extend("force", opts, { desc = "Close and deny" }))
        vim.keymap.set("n", "<Tab>", "<C-w>w", vim.tbl_extend("force", opts, { desc = "Next diff pane" }))
        vim.keymap.set("n", "<S-Tab>", "<C-w>W", vim.tbl_extend("force", opts, { desc = "Prev diff pane" }))
        vim.keymap.set("n", "<leader>h", function()
            open_hunk_picker(current_lines, proposed_lines, mid_win)
        end, vim.tbl_extend("force", opts, { desc = "Browse hunks in Telescope" }))
        vim.keymap.set("n", "zm", "zM", vim.tbl_extend("force", opts, { desc = "Refold all unchanged sections" }))
        vim.keymap.set("n", "<leader>s", function()
            history.open_diff_history()
        end, vim.tbl_extend("force", opts, { desc = "Browse session diff history" }))
    end

    map_diff_keys(current_buf)
    map_diff_keys(proposed_buf)
    map_diff_keys(reference_buf)
    map_diff_keys(help_buf)

    local _tok = guard.register_pending("permission", function()
        vim.schedule(function()
            local ok, popups = pcall(require, "kra_agent.popups")
            if ok and popups.request_permission then
                popups.request_permission(channel_id, payload)
            end
        end)
    end)
    guard.guard_buffer("permission", proposed_buf, _tok)

    vim.api.nvim_set_current_win(mid_win)
end

return M
