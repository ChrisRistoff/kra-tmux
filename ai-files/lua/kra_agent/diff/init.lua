local M = {}

local editor = require("kra_agent.diff.editor")
local history = require("kra_agent.diff.history")
local helpers = require("kra_agent.diff.helpers")

M.open_args_editor = editor.open_args_editor
M.open_write_diff_editor = editor.open_write_diff_editor
M.finalize_pending_diff = history.finalize_pending_diff
M.open_diff_history = history.open_diff_history
M.extract_write_preview = helpers.extract_write_preview

return M
