-- kra notes: delete the current note (with confirmation) and close the buffer.
-- Mapped to <leader>X in markdown buffers under the notes root. Also exposes
-- :KraNotesDelete and a Telescope-driven picker via <leader>X in non-note buffers.

local M = {}

local notes_root

local function rel(file)
  local prefix = notes_root .. '/'
  if file:sub(1, #prefix) == prefix then
    return file:sub(#prefix + 1)
  end
  return file
end

local function delete_file(path, on_done)
  if vim.fn.filereadable(path) == 0 then
    vim.notify('[kra notes] not a file: ' .. path, vim.log.levels.WARN)
    return
  end
  if not path:match('^' .. vim.pesc(notes_root)) then
    vim.notify('[kra notes] refusing to delete outside notes root', vim.log.levels.ERROR)
    return
  end

  local answer = vim.fn.confirm('Delete ' .. rel(path) .. '?', '&Yes\n&No', 2, 'Question')
  if answer ~= 1 then return end

  -- Wipe any buffer pointing at this file before unlinking.
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_buf_get_name(buf) == path then
      vim.api.nvim_buf_delete(buf, { force = true })
    end
  end

  local ok, err = os.remove(path)
  if not ok then
    vim.notify('[kra notes] delete failed: ' .. tostring(err), vim.log.levels.ERROR)
    return
  end
  vim.notify('[kra notes] deleted ' .. rel(path))
  if on_done then on_done() end
end

local function delete_current()
  local file = vim.fn.expand('%:p')
  if file == '' then
    vim.notify('[kra notes] no file in this buffer', vim.log.levels.WARN)
    return
  end
  delete_file(file)
end

local function delete_pick()
  local ok, builtin = pcall(require, 'telescope.builtin')
  if not ok then
    vim.notify('[kra notes] telescope not available', vim.log.levels.ERROR)
    return
  end
  local actions = require('telescope.actions')
  local action_state = require('telescope.actions.state')
  builtin.find_files({
    prompt_title = 'Delete note',
    cwd = notes_root,
    attach_mappings = function(prompt_bufnr, map)
      local function confirm()
        local entry = action_state.get_selected_entry()
        actions.close(prompt_bufnr)
        if entry then
          local path = entry.path or (notes_root .. '/' .. entry.value)
          delete_file(path)
        end
      end
      map('i', '<CR>', confirm)
      map('n', '<CR>', confirm)
      return true
    end,
  })
end

function M.setup(root)
  notes_root = root

  vim.api.nvim_create_user_command('KraNotesDelete', function(opts)
    if opts.args and opts.args ~= '' then
      local path = opts.args
      if not path:match('^/') then path = notes_root .. '/' .. path end
      if not path:match('%.md$') then path = path .. '.md' end
      delete_file(path)
    else
      delete_current()
    end
  end, { nargs = '?', complete = 'file' })

  vim.api.nvim_create_user_command('KraNotesDeletePick', function() delete_pick() end, {})

  -- Buffer-local <leader>X in note buffers; global picker fallback otherwise.
  local grp = vim.api.nvim_create_augroup('KraNotesDelete', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWinEnter' }, {
    group = grp,
    pattern = notes_root .. '/*.md',
    callback = function(args)
      vim.keymap.set('n', '<leader>X', delete_current,
        { buffer = args.buf, nowait = true, silent = true, desc = 'kra notes: delete current note' })
    end,
  })

  -- Global fallback so <leader>X works even when not in a note buffer.
  vim.keymap.set('n', '<leader>X', function()
    local file = vim.fn.expand('%:p')
    if file ~= '' and file:match('^' .. vim.pesc(notes_root)) and file:match('%.md$') then
      delete_current()
    else
      delete_pick()
    end
  end, { desc = 'kra notes: delete note (current or pick)' })
end

return M
