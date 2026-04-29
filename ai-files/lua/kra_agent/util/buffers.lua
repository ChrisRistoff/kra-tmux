local M = {}

function M.configure_scratch_buffer(buf, name, filetype, modifiable)
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

return M
