local M = {}

M.ns = vim.api.nvim_create_namespace("kra_agent_diff")

-- Session-wide log of write diffs the user APPROVED *and* the tool actually
-- applied. Denied diffs (or approved-with-edits that the tool later rejected)
-- are never recorded — see pending_diff_entries below.
-- diff_history entries store SHA refs (current_sha / applied_sha / proposed_sha)
-- pointing into kra_agent.util.spill on disk — NOT the line tables themselves.
-- See kra_agent.diff.history.finalize_pending_diff for the spill point and
-- load_entry_lines() for the inverse. This keeps the lua heap from growing
-- O(diff_count * file_size) over a long session.
M.diff_history = {}
-- Keyed by absolute path. Value is the SHA of the pre-session file content
-- spilled to disk (or nil if the path has never been touched). Loaded back
-- via spill.load_lines() in the revert UI.
M.original_by_path = {}
M.crlf_by_path = {} -- true if the original file used CRLF line endings

-- FIFO of approved diff entries waiting for the matching tool.execution_complete
-- event. The TS layer calls finalize_pending_diff(success) once per completed
-- tool; we then either commit the entry to diff_history (success) or discard
-- it (failure / intercepted deny).
M.pending_diff_entries = {}

return M
