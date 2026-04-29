local M = {}

function M.safe_notify(channel_id, method, ...)
    if type(channel_id) ~= "number" then
        vim.notify("Tool approval could not be sent because the agent session is unavailable.", vim.log.levels.WARN, {
            title = "Tool Approval",
        })
        return false
    end

    local channel_ok = pcall(vim.api.nvim_get_chan_info, channel_id)
    if not channel_ok then
        vim.notify("The agent session closed before this approval decision could be delivered.", vim.log.levels.WARN, {
            title = "Tool Approval",
            timeout = 4000,
        })
        return false
    end

    local ok, err = pcall(vim.fn.rpcnotify, channel_id, method, ...)
    if not ok then
        vim.notify(string.format("Tool approval failed to send: %s", tostring(err)), vim.log.levels.WARN, {
            title = "Tool Approval",
            timeout = 4000,
        })
        return false
    end

    return true
end

function M.send_action(action, args)
    local channel = vim.g.kra_agent_channel
    if not channel or channel == 0 then
        vim.notify("kra-memory: agent channel not registered", vim.log.levels.ERROR)
        return false
    end
    pcall(vim.fn.rpcnotify, channel, "prompt_action", action, args or vim.empty_dict())
    return true
end

return M
