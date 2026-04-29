local M = {}

local buffers = require("kra_agent.util.buffers")
local json = require("kra_agent.util.json")

function M.join_buffer_text(buf, keep_trailing_newline)
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

function M.infer_filetype(filename)
    local ok, detected = pcall(vim.filetype.match, { filename = filename })
    if ok and type(detected) == "string" then
        return detected
    end

    return ""
end

function M.configure_scratch_buffer(buf, name, filetype, modifiable)
    buffers.configure_scratch_buffer(buf, name, filetype, modifiable)
end

function M.pretty_json(value)
    return json.pretty_structured(value)
end

function M.extract_write_preview(payload)
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
function M.setup_diff_highlights()
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
function M.compute_diff_stats(a_lines, b_lines)
    local hunks = vim.diff(
        table.concat(a_lines, "\n") .. "\n",
        table.concat(b_lines, "\n") .. "\n",
        { result_type = "indices" }
    )
    local added, removed = 0, 0
    for _, h in ipairs(hunks or {}) do
        removed = removed + h[2]
        added = added + h[4]
    end
    return added, removed
end

return M
