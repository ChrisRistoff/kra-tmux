local state = {
    active_entry_index = nil,
    -- Map of tool_call_id -> history index. Lets concurrent tool executions
    -- (multiple in-flight at once) update the right history entry instead of
    -- clobbering whichever one happened to be active_entry_index. The single
    -- active_entry_index is kept as a fallback for legacy callers that don't
    -- pass a tool_call_id (e.g. AIChat path).
    entries_by_call_id = {},
    body = "Ready",
    history = {},
    icon = "󱚩",
    level = vim.log.levels.INFO,
    notification = nil,
    popups_hidden = false,
    spinner_index = 1,
    spinning = false,
    statusline = "Ready",
    timer = nil,
    title = "Copilot Agent",
    executable_tools = {},
    tool_result_win = nil,
    tool_result_buf = nil,
    index_progress_buf = nil,
    index_progress_win = nil,
    index_progress_alias = "",
    index_progress_total = 0,
    index_progress_done = 0,
    index_progress_started_at = nil,
    index_progress_channel = nil,
    index_progress_finished = false,
    index_progress_summary = nil,
}

return state
