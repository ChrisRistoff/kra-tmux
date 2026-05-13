-- kra notes: backlinks. Uses ripgrep to find references to the current note.
local M = {}

function M.setup(notes_root)
  vim.keymap.set('n', '<leader>b', function()
    local file = vim.fn.expand('%:p')
    if file == '' then
      print('[kra notes] no file open')
      return
    end
    local prefix = notes_root .. '/'
    if file:sub(1, #prefix) ~= prefix then
      print('[kra notes] current file is outside notes root')
      return
    end
    local rel = file:sub(#prefix + 1)
    local stem = vim.fn.fnamemodify(file, ':t:r')

    local results = {}
    local seen = {}
    local function run(pattern)
      local out = vim.fn.systemlist({ 'rg', '--vimgrep', '--no-heading', '-F', pattern, notes_root })
      for _, line in ipairs(out) do
        if not seen[line] and not line:find(rel, 1, true) then
          seen[line] = true
          table.insert(results, line)
        end
      end
    end

    run('[[' .. stem .. ']]')
    run('[[' .. rel:gsub('%.md$', '') .. ']]')
    run('](' .. rel .. ')')

    if #results == 0 then
      print('[kra notes] no backlinks for ' .. stem)
      return
    end

    -- Convert into quickfix list, then open via Telescope if available.
    local qf = {}
    for _, line in ipairs(results) do
      local f, l, c, txt = line:match('([^:]+):(%d+):(%d+):(.*)')
      if f then
        table.insert(qf, { filename = f, lnum = tonumber(l), col = tonumber(c), text = txt })
      end
    end
    vim.fn.setqflist(qf, 'r')

    local ok = pcall(require, 'telescope')
    if ok then
      require('telescope.builtin').quickfix({ prompt_title = 'Backlinks: ' .. stem })
    else
      vim.cmd('copen')
    end
  end, { desc = 'kra notes: backlinks' })
end

return M
