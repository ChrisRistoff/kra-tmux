local M = {}

local ns = vim.api.nvim_create_namespace("kra_agent_diff")

-- Session-wide log of write diffs the user APPROVED *and* the tool actually
-- applied. Denied diffs (or approved-with-edits that the tool later rejected)
-- are never recorded — see pending_diff_entries below.
local diff_history = {}
local original_by_path = {} -- first-seen content for each path, for revert
local crlf_by_path = {} -- true if the original file used CRLF line endings

-- FIFO of approved diff entries waiting for the matching tool.execution_complete
-- event. The TS layer calls M.finalize_pending_diff(success) once per completed
-- tool; we then either commit the entry to diff_history (success) or discard
-- it (failure / intercepted deny).
local pending_diff_entries = {}

local function join_buffer_text(buf, keep_trailing_newline)
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)

    if #lines == 0 then
        return keep_trailing_newline and "\n" or ""
    end

    local text = table.concat(lines, "\n")
    if keep_trailing_newline and text:sub(-1) ~= "\n" then
        text = text .. "\n"
    end

    return text
end

local function infer_filetype(filename)
    local ok, detected = pcall(vim.filetype.match, { filename = filename })
    if ok and type(detected) == "string" then
        return detected
    end

    return ""
end

local function configure_scratch_buffer(buf, name, filetype, modifiable)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    vim.bo[buf].modifiable = true

    if name and name ~= "" then
        -- Append a unique suffix to avoid name conflicts with prior invocations
        local unique_name = string.format("%s [%d]", name, buf)
        pcall(vim.api.nvim_buf_set_name, buf, unique_name)
    end

    if filetype and filetype ~= "" then
        vim.bo[buf].filetype = filetype
    end

    vim.bo[buf].modifiable = modifiable
    vim.bo[buf].readonly = not modifiable
    vim.bo[buf].modified = false
end

local function pretty_json(value)
    if type(value) ~= "string" or value == "" then
        return "{}"
    end

    local ok, decoded = pcall(vim.json.decode, value)
    if not ok then
        return value
    end

    -- Handle double-encoded JSON (string wrapping a JSON object)
    if type(decoded) == "string" then
        local nested_ok, nested = pcall(vim.json.decode, decoded)
        if nested_ok and type(nested) == "table" then
            decoded = nested
        else
            return decoded
        end
    end

    if type(decoded) ~= "table" then
        return value
    end

    -- Pretty-print with 2-space indent
    local encode_ok, encoded = pcall(vim.fn.json_encode, decoded)
    if not encode_ok then
        return value
    end

    -- Use a simple recursive formatter
    local indent = 0
    local result = {}
    local in_string = false
    local escape_next = false

    for i = 1, #encoded do
        local char = encoded:sub(i, i)

        if escape_next then
            table.insert(result, char)
            escape_next = false
        elseif char == "\\" and in_string then
            table.insert(result, char)
            escape_next = true
        elseif char == '"' then
            in_string = not in_string
            table.insert(result, char)
        elseif in_string then
            table.insert(result, char)
        elseif char == "{" or char == "[" then
            indent = indent + 1
            table.insert(result, char)
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
        elseif char == "}" or char == "]" then
            indent = indent - 1
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
            table.insert(result, char)
        elseif char == "," then
            table.insert(result, char)
            table.insert(result, "\n")
            table.insert(result, string.rep("  ", indent))
        elseif char == ":" then
            table.insert(result, char)
            table.insert(result, " ")
        elseif char ~= " " then
            table.insert(result, char)
        end
    end

    return table.concat(result)
end

local function extract_write_preview(payload)
    if not payload.hasWritePreview then
        return nil
    end

    return {
        currentPath = payload.previewCurrentPath,
        proposedPath = payload.previewProposedPath,
        displayPath = payload.previewDisplayPath or "file",
        applyStrategy = payload.previewApplyStrategy or "content-field",
        proposedEndsWithNewline = payload.previewEndsWithNewline or false,
        note = payload.previewNote,
    }
end

-- Define distinctive diff highlight groups applied per-window via winhighlight,
-- so the user's global theme is never mutated.
local function setup_diff_highlights()
    local defined = vim.api.nvim_get_hl(0, { name = "KraDiffAdd", create = false })
    if defined and defined.bg then
        return
    end -- already set up this session

    vim.api.nvim_set_hl(0, "KraDiffAdd", { bg = "#1e3a2e" })
    vim.api.nvim_set_hl(0, "KraDiffDelete", { bg = "#3b1c1c" })
    vim.api.nvim_set_hl(0, "KraDiffChange", { bg = "#2c2a18" })
    vim.api.nvim_set_hl(0, "KraDiffText", { bg = "#4d440e", bold = true })
    -- SignColumn and line-number columns inside diff windows look cleaner when neutral.
    vim.api.nvim_set_hl(0, "KraDiffSign", { link = "SignColumn" })
end

-- Computes +added/-removed line counts by diffing two line arrays.
local function compute_diff_stats(a_lines, b_lines)
    local hunks =
        vim.diff(table.concat(a_lines, "\n") .. "\n", table.concat(b_lines, "\n") .. "\n", { result_type = "indices" })
    local added, removed = 0, 0
    for _, h in ipairs(hunks or {}) do
        removed = removed + h[2]
        added = added + h[4]
    end
    return added, removed
end

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
    local args_json = pretty_json(payload.argsJson)
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
    configure_scratch_buffer(
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
    configure_scratch_buffer(
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
    local preview = extract_write_preview(payload)
    if not preview or not preview.currentPath or not preview.proposedPath then
        M.open_args_editor(channel_id, payload, send_fn)
        return
    end

    local filetype = infer_filetype(preview.displayPath or "")

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

    local diff_added, diff_removed = compute_diff_stats(current_lines, proposed_lines)
    local diff_stats = string.format("+%d -%d", diff_added, diff_removed)

    -- Build a history entry, but DO NOT commit it to diff_history yet. The
    -- entry is only recorded once (a) the user approves and (b) the underlying
    -- tool actually applies the write. See M.finalize_pending_diff below.
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

    setup_diff_highlights()

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
    configure_scratch_buffer(
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
    configure_scratch_buffer(proposed_buf, string.format("result:%s", preview.displayPath or "result"), filetype, true)

    -- RIGHT pane: AI proposed reference (read-only).
    vim.cmd("rightbelow vsplit")
    local right_win = vim.api.nvim_get_current_win()
    local reference_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_win_set_buf(right_win, reference_buf)
    vim.api.nvim_buf_set_lines(reference_buf, 0, -1, false, proposed_lines)
    configure_scratch_buffer(
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
        cline(
            "LEFT  CURRENT (read-only)    \226\148\130    MIDDLE  RESULT \226\156\143 (edit here)    \226\148\130    RIGHT  AI PROPOSED (ref)"
        ),
        "",
        cline(
            "<Space>a  approve    <Space>d  deny    <Space>j  raw JSON    <Space>h  hunks    <Space>s  session history    q  quit"
        ),
        cline("<Tab> / <S-Tab>  switch pane    ]c / [c  jump hunks    zm  refold"),
    }
    vim.api.nvim_buf_set_lines(help_buf, 0, -1, false, help_lines)
    configure_scratch_buffer(help_buf, "diff-help", "", false)

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
    vim.wo[left_win].winbar = string.format(" CURRENT (read-only)  │  %s", display)
    vim.wo[mid_win].winbar = preview.note
            and string.format(
                " RESULT \226\156\143 (edit here)  \226\148\130  %s  %s  \226\154\160 %s",
                display,
                diff_stats,
                preview.note
            )
        or string.format(" RESULT \226\156\143 (edit here)  \226\148\130  %s  %s", display, diff_stats)
    vim.wo[right_win].winbar = string.format(" AI PROPOSED (ref)  │  %s", display)

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

        local current_text = join_buffer_text(current_buf, false)
        local approved_text = join_buffer_text(proposed_buf, preview.proposedEndsWithNewline)

        if
            preview.applyStrategy == "edit-tool"
            and type(payload.toolName) == "string"
            and payload.toolName:find("edit_lines")
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
                -- __userFinalContent so the TS side knows to transform the
                -- edit_lines call accordingly.
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
                    table.insert(pending_diff_entries, history_entry)
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
            -- M.finalize_pending_diff(success) once the tool actually runs.
            -- Only successful runs get committed to diff_history.
            table.insert(pending_diff_entries, history_entry)
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
            M.open_diff_history()
        end, vim.tbl_extend("force", opts, { desc = "Browse session diff history" }))
    end

    map_diff_keys(current_buf)
    map_diff_keys(proposed_buf)
    map_diff_keys(reference_buf)
    map_diff_keys(help_buf)

    vim.api.nvim_set_current_win(mid_win)
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

    setup_diff_highlights()
    local saved_diffopt = vim.o.diffopt
    vim.o.diffopt = "internal,filler,closeoff,linematch:60"
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local diff_tab = vim.api.nvim_get_current_tabpage()
    local ft = infer_filetype(vim.fn.fnamemodify(path, ":t"))

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
        local sep = (crlf_by_path[path] or false) and "\r\n" or "\n"
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
    setup_diff_highlights()
    local ft = infer_filetype(vim.fn.fnamemodify(entry.path or "", ":t"))
    local saved_diffopt = vim.o.diffopt
    vim.o.diffopt = "internal,filler,closeoff,linematch:60"
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local diff_tab = vim.api.nvim_get_current_tabpage()

    -- LEFT: before (read-only reference)
    local left_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(left_buf, 0, -1, false, entry.current_lines or {})
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
    vim.api.nvim_buf_set_lines(right_buf, 0, -1, false, entry.applied_lines or entry.proposed_lines or {})
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
        local sep = (crlf_by_path[path] or false) and "\r\n" or "\n"
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
    local entry = table.remove(pending_diff_entries, 1)
    if not entry then
        return
    end
    if not success then
        return
    end
    entry.seq = #diff_history + 1
    entry.status = "approved"
    if not original_by_path[entry.path] then
        original_by_path[entry.path] = entry.current_lines
        crlf_by_path[entry.path] = entry.current_crlf
    end
    table.insert(diff_history, entry)
end

-- Opens a Telescope picker listing every write diff opened this session.
-- Each entry is numbered (#1 = first, #N = latest).  ORIG entries at the
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

    if #diff_history == 0 then
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
    for i = #diff_history, 1, -1 do
        table.insert(results, { kind = "diff", entry = diff_history[i] })
    end
    local seen = {}
    for _, e in ipairs(diff_history) do
        if not seen[e.path] then
            seen[e.path] = true
            table.insert(results, {
                kind = "original",
                path = e.path,
                original_lines = original_by_path[e.path] or {},
            })
        end
    end

    local status_icon = { pending = "\239\164\164", approved = "\239\144\172", denied = "\239\144\150" }

    pickers
        .new({}, {
            prompt_title = string.format("Session Diff History  (%d diffs)", #diff_history),
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
                            original_by_path[item.path] or { "(no content recorded)" }
                        )
                        return
                    end
                    local h = item.entry
                    local a_lines, b_lines = h.current_lines, h.applied_lines or h.proposed_lines

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
                            local orig = original_by_path[item.path]
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

M.extract_write_preview = extract_write_preview

return M
