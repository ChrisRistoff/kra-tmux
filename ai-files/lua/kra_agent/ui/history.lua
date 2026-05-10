local M = {}

local state = require("kra_agent.ui.state")
local rpc = require("kra_agent.util.rpc")
local json = require("kra_agent.util.json")
local spill = require("kra_agent.util.spill")

-- Tool history entries can carry tens of KB each (full args_json + full tool
-- output). With hundreds of calls per session that adds up to multi-MB of
-- string content held in the lua heap forever. We spill the heavy fields to
-- disk and only keep sha refs; the popup loads them back when actually opened.
local function load_args(entry)
    if entry.args_sha then return spill.load(entry.args_sha) or "" end
    return entry.args_json or ""
end

local function load_full_result(entry)
    if entry.full_result_sha then return spill.load(entry.full_result_sha) or "" end
    return entry.full_result or ""
end

-- Resolve the existing history entry for a given tool_call_id, falling back
-- to the legacy single active_entry_index when no id is provided. Returns
-- (index, entry) or (nil, nil) if no entry exists yet.
local function find_entry(tool_call_id)
    if tool_call_id and state.entries_by_call_id[tool_call_id] then
        local idx = state.entries_by_call_id[tool_call_id]
        local entry = state.history[idx]
        if entry then
            return idx, entry
        end
        -- Stale mapping: the entry was wiped. Drop the dangling pointer.
        state.entries_by_call_id[tool_call_id] = nil
    end

    if not tool_call_id and state.active_entry_index and state.history[state.active_entry_index] then
        return state.active_entry_index, state.history[state.active_entry_index]
    end

    return nil, nil
end

function M.upsert_history(tool_name, details, args_json, tool_call_id)
    local timestamp = os.date("%H:%M:%S")

    local _, entry = find_entry(tool_call_id)
    if entry then
        entry.details = details
        entry.updated_at = timestamp
        if args_json and args_json ~= "" and entry.args_sha == nil and (entry.args_json == nil or entry.args_json == "") then
            entry.args_sha = spill.spill(args_json)
            entry.args_json = nil
        end
        return entry
    end

    entry = {
        args_sha = (args_json and args_json ~= "") and spill.spill(args_json) or nil,
        details = details,
        started_at = timestamp,
        status = "running",
        title = tool_name,
        tool_call_id = tool_call_id,
        updated_at = timestamp,
    }
    table.insert(state.history, entry)
    local idx = #state.history
    if tool_call_id then
        state.entries_by_call_id[tool_call_id] = idx
    else
        -- Legacy callers (no tool_call_id) rely on the single active pointer.
        state.active_entry_index = idx
    end
    return entry
end

function M.complete_history(tool_name, details, success, full_result, tool_call_id)
    local _, entry = find_entry(tool_call_id)
    if not entry then
        -- No matching start_tool was recorded — create a placeholder so the
        -- result still shows up in history. Args will be empty in this case;
        -- that is intentional, since they were never reported.
        entry = M.upsert_history(tool_name, details, nil, tool_call_id)
    end

    entry.title = tool_name
    entry.result = details
    -- Full tool output can be huge (file reads, bash output, search results).
    -- Spill to disk and keep only the sha; the popup lazy-loads on open.
    local raw_full = (full_result and full_result ~= "") and full_result or details
    if raw_full and raw_full ~= "" then
        entry.full_result_sha = spill.spill(raw_full)
    end
    entry.full_result = nil
    entry.details = details
    entry.status = success and "done" or "failed"
    entry.updated_at = os.date("%H:%M:%S")

    if tool_call_id then
        state.entries_by_call_id[tool_call_id] = nil
    else
        state.active_entry_index = nil
    end
end

local function open_history_view(entry)
    local original_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd("tabnew")
    local view_tab = vim.api.nvim_get_current_tabpage()

    local args_raw = load_args(entry)
    local args_text = json.pretty_via_jq((args_raw and args_raw ~= "") and args_raw or "{}")
    local result_raw = load_full_result(entry)
    if not result_raw or result_raw == "" then
        result_raw = entry.result or entry.details or "(no result recorded)"
    end
    local result_text = json.pretty_via_jq(result_raw)
    local is_executable = state.executable_tools[entry.title] ~= nil

    -- LEFT (visually right after vsplit): args JSON. Editable when the tool is
    -- in our executable map so the user can tweak args and re-run.
    local left_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(left_buf, 0, -1, false, vim.split(args_text, "\n", { plain = true }))
    vim.bo[left_buf].buftype = "nofile"
    vim.bo[left_buf].bufhidden = "wipe"
    vim.bo[left_buf].swapfile = false
    vim.bo[left_buf].filetype = "json"
    vim.bo[left_buf].modifiable = is_executable
    vim.bo[left_buf].modified = false
    local left_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(left_win, left_buf)
    vim.wo[left_win].number = true
    vim.wo[left_win].wrap = false
    local args_hint = is_executable and "  (<leader>a run, <leader>q close)" or ""
    vim.wo[left_win].winbar = string.format(" 󰘦 ARGS  %s  [%s]%s ", entry.title or "tool", entry.status or "?", args_hint)

    -- RIGHT (visually left after vsplit): last recorded result.
    vim.cmd("vsplit")
    local right_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(right_buf, 0, -1, false, vim.split(result_text, "\n", { plain = true }))
    vim.bo[right_buf].buftype = "nofile"
    vim.bo[right_buf].bufhidden = "wipe"
    vim.bo[right_buf].swapfile = false
    vim.bo[right_buf].modifiable = false
    vim.bo[right_buf].modified = false
    local right_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(right_win, right_buf)
    vim.wo[right_win].number = true
    vim.wo[right_win].wrap = true
    vim.wo[right_win].winbar = string.format(
        " 󰊕 RESULT  %s  ·  %s → %s ",
        entry.title or "tool",
        entry.started_at or "",
        entry.updated_at or ""
    )

    local function close_view()
        if vim.api.nvim_tabpage_is_valid(view_tab) then
            vim.cmd("tabclose")
        end
        if vim.api.nvim_tabpage_is_valid(original_tab) then
            vim.api.nvim_set_current_tabpage(original_tab)
        end
    end

    local base = { silent = true, nowait = true }
    for _, buf in ipairs({ left_buf, right_buf }) do
        local o = vim.tbl_extend("force", base, { buffer = buf })
        vim.keymap.set("n", "q", close_view, vim.tbl_extend("force", o, { desc = "Close tool view" }))
        vim.keymap.set("n", "<leader>q", close_view, vim.tbl_extend("force", o, { desc = "Close tool view" }))
        vim.keymap.set("n", "<Tab>", "<C-w>w", vim.tbl_extend("force", o, { desc = "Next pane" }))
        vim.keymap.set("n", "<S-Tab>", "<C-w>W", vim.tbl_extend("force", o, { desc = "Prev pane" }))
    end

    if is_executable then
        local run_opts = vim.tbl_extend("force", base, { buffer = left_buf, desc = "Run tool with edited args" })
        vim.keymap.set("n", "<leader>a", function()
            local lines = vim.api.nvim_buf_get_lines(left_buf, 0, -1, false)
            local text = table.concat(lines, "\n")
            local ok, _ = pcall(vim.json.decode, text)
            if not ok then
                vim.notify("Invalid JSON in args buffer", vim.log.levels.WARN, { title = "kra-agent" })
                return
            end
            rpc.send_action("execute_tool", { title = entry.title, args_json = text })
            vim.notify("Running " .. entry.title .. "...", vim.log.levels.INFO, { title = "kra-agent" })
        end, run_opts)
    end

    vim.api.nvim_set_current_win(left_win)
end

function M.show_history()
    local ok, err = pcall(function()
        local pickers = require("telescope.pickers")
        local finders = require("telescope.finders")
        local previewers = require("telescope.previewers")
        local conf = require("telescope.config").values
        local actions = require("telescope.actions")
        local action_state = require("telescope.actions.state")

        if #state.history == 0 then
            vim.notify("No tool calls recorded yet.", vim.log.levels.INFO)
            return
        end

        local results = {}
        for index = #state.history, 1, -1 do
            table.insert(results, state.history[index])
        end

        pickers
            .new({
                layout_strategy = "horizontal",
                layout_config = { preview_width = 0.55, width = 0.95, height = 0.85 },
            }, {
                prompt_title = string.format("Agent Tool History  (%d calls)", #state.history),
                finder = finders.new_table({
                    results = results,
                    entry_maker = function(entry)
                        local icon = entry.status == "done" and "󰄬" or entry.status == "failed" and "󰅖" or "󱁤"
                        return {
                            value = entry,
                            display = string.format(
                                "%s %s · %s",
                                icon,
                                entry.title,
                                entry.updated_at or entry.started_at or ""
                            ),
                            ordinal = string.format(
                                "%s %s %s",
                                entry.title or "",
                                entry.status or "",
                                entry.details or ""
                            ),
                        }
                    end,
                }),
                previewer = previewers.new_buffer_previewer({
                    title = "Tool args + result",
                    define_preview = function(self, entry)
                        local item = entry.value
                        local args_raw = load_args(item)
                        local args = json.pretty_via_jq((args_raw and args_raw ~= "") and args_raw or "(none)")
                        local result = json.pretty_via_jq(item.result or item.details or "(no result)")
                        local sep = string.rep("─", 60)
                        local text = table.concat({
                            "── ARGS " .. string.rep("─", 54),
                            args,
                            "",
                            "── RESULT " .. string.rep("─", 52),
                            result,
                            sep,
                        }, "\n")
                        vim.api.nvim_buf_set_lines(
                            self.state.bufnr,
                            0,
                            -1,
                            false,
                            vim.split(text, "\n", { plain = true })
                        )
                    end,
                }),
                sorter = conf.generic_sorter({}),
                attach_mappings = function(prompt_bufnr)
                    actions.select_default:replace(function()
                        local sel = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        if not sel then
                            return
                        end
                        open_history_view(sel.value)
                    end)
                    return true
                end,
            })
            :find()
    end)

    if not ok then
        vim.notify(string.format("Agent tool history failed: %s", tostring(err)), vim.log.levels.ERROR)
    end
end

return M
