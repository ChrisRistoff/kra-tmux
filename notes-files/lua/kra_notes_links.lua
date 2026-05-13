-- kra notes: link insertion + follow.
local M = {}

local notes_root

local function rel_to_root(path)
  local prefix = notes_root .. '/'
  if path:sub(1, #prefix) == prefix then
    return path:sub(#prefix + 1)
  end
  return path
end

-- Insert [[relpath-without-md]] for the chosen note.
local function insert_link_picker()
  local ok = pcall(require, 'telescope')
  if not ok then
    print('[kra notes] telescope not yet installed')
    return
  end
  local actions = require('telescope.actions')
  local action_state = require('telescope.actions.state')

  require('telescope.builtin').find_files({
    cwd = notes_root,
    prompt_title = 'Insert link to note',
    attach_mappings = function(prompt_bufnr, _)
      actions.select_default:replace(function()
        local entry = action_state.get_selected_entry()
        actions.close(prompt_bufnr)
        if not entry then return end
        local rel = rel_to_root(entry.path or (notes_root .. '/' .. entry[1]))
        rel = rel:gsub('%.md$', '')
        local row, col = unpack(vim.api.nvim_win_get_cursor(0))
        local snippet = '[[' .. rel .. ']]'
        vim.api.nvim_buf_set_text(0, row - 1, col, row - 1, col, { snippet })
        vim.api.nvim_win_set_cursor(0, { row, col + #snippet })
      end)
      return true
    end,
  })
end

-- Find a [[wiki-link]] or [text](path) under the cursor and open it.
local function follow_link()
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1

  -- [[wiki-link]]
  local s, e = 1, 0
  while true do
    local ws, we, target = line:find('%[%[(.-)%]%]', e + 1)
    if not ws then break end
    if col >= ws and col <= we then
      local target_path = notes_root .. '/' .. target:gsub('%.md$', '') .. '.md'
      vim.fn.mkdir(vim.fn.fnamemodify(target_path, ':h'), 'p')
      vim.cmd('edit ' .. vim.fn.fnameescape(target_path))
      return
    end
    s, e = ws, we
  end

  -- [text](path)
  e = 0
  while true do
    local ms, me, _, target = line:find('%[([^%]]-)%]%(([^)]+)%)', e + 1)
    if not ms then break end
    if col >= ms and col <= me then
      if target:match('^https?://') or target:match('^mailto:') then
        vim.fn.jobstart({ vim.fn.has('mac') == 1 and 'open' or 'xdg-open', target }, { detach = true })
        return
      end
      local target_path = target
      if not target_path:match('^/') then
        target_path = notes_root .. '/' .. target_path
      end
      vim.fn.mkdir(vim.fn.fnamemodify(target_path, ':h'), 'p')
      vim.cmd('edit ' .. vim.fn.fnameescape(target_path))
      return
    end
    e = me
  end

  print('[kra notes] no link under cursor')
end

function M.setup(root)
  notes_root = root
  vim.keymap.set('n', '<leader>l', insert_link_picker, { desc = 'kra notes: insert link' })
  vim.keymap.set({ 'n', 'i' }, '<C-]>', function()
    if vim.fn.mode() == 'i' then
      vim.cmd('stopinsert')
    end
    follow_link()
  end, { desc = 'kra notes: follow link' })
  vim.keymap.set('n', '<CR>', follow_link, { desc = 'kra notes: follow link' })
  vim.keymap.set('n', 'gf', follow_link, { desc = 'kra notes: follow link' })
end

return M
