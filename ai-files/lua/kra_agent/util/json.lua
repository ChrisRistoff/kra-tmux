local M = {}

function M.pretty_via_jq(text)
    if type(text) ~= "string" or text == "" then
        return text or ""
    end
    local first = text:match("^%s*(.)")
    if first ~= "{" and first ~= "[" then
        return text
    end
    local out = vim.fn.system({ "jq", "." }, text)
    if vim.v.shell_error ~= 0 then
        return text
    end
    return (out:gsub("\n$", ""))
end

function M.pretty_structured(value)
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

return M
