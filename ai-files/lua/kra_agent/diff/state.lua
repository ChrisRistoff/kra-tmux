local M = {}

M.ns = vim.api.nvim_create_namespace("kra_agent_diff")

-- Session-wide log of write diffs the user APPROVED *and* the tool actually
-- applied. Denied diffs (or approved-with-edits that the tool later rejected)
-- are never recorded — see pending_diff_entries below.
M.diff_history = {}
M.original_by_path = {} -- first-seen content for each path, for revert
M.crlf_by_path = {} -- true if the original file used CRLF line endings

-- FIFO of approved diff entries waiting for the matching tool.execution_complete
-- event. The TS layer calls finalize_pending_diff(success) once per completed
-- tool; we then either commit the entry to diff_history (success) or discard
-- it (failure / intercepted deny).
M.pending_diff_entries = {}

return M
