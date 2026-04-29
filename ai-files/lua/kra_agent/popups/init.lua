local M = {}

local guard = require("kra_agent.popups.guard")
local user_input = require("kra_agent.popups.user_input")
local permission = require("kra_agent.popups.permission")

M.register_pending = guard.register_pending
M.clear_pending = guard.clear_pending
M.guard_window = guard.guard_window
M.guard_buffer = guard.guard_buffer
M.revive_all = guard.revive_all
M.set_popups_hidden = guard.set_hidden

M.request_user_input = user_input.request_user_input
M.hide_user_input_window = user_input.hide_user_input_window
M.show_user_input_window = user_input.show_user_input_window
M.hide_freeform_input = user_input.hide_freeform_input
M.show_freeform_input = user_input.show_freeform_input

M.request_permission = permission.request_permission
M.hide_permission_window = permission.hide_permission_window
M.show_permission_window = permission.show_permission_window

return M
