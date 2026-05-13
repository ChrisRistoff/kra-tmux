-- kra notes: rename / move the current note. Optionally rewrites incoming
-- [[wiki]] and ](path) links across the vault.

local M = {}

local notes_root

local function rel(file)
  local prefix = notes_root .. '/'
  if file:sub(1, #prefix) == prefix then
    return file:sub(#prefix + 1):gsub('%.md$', '')
  end
  return file:gsub('%.md$', '')
end

local function abs(rel_path)
  local p = rel_path
  if not p:match('^/') then p = notes_root .. '/' .. p end
  if not p:match('%.md$') then p = p .. '.md' end
  return p
end

local function list_md_files()
  local files = vim.fn.systemlist({ 'rg', '--files', '--type-add', 'md:*.md', '--type', 'md',
    '--glob', '!**/.nvim-data/**', notes_root })
  if vim.v.shell_error ~= 0 then
    files = vim.fn.systemlist({ 'find', notes_root, '-type', 'f', '-name', '*.md',
      '-not', '-path', '*/.nvim-data/*' })
  end
  return files
end

local function rewrite_links(old_rel, new_rel)
  local changed = 0
  local old_esc = old_rel:gsub('([%(%)%.%%%+%-%*%?%[%]%^%$])', '%%%1')
  for _, file in ipairs(list_md_files()) do
    local fh = io.open(file, 'r')
    if fh then
      local content = fh:read('*a')
      fh:close()
      local original = content
      -- [[old_rel]] and [[old_rel.md]] (wiki-style)
      content = content:gsub('%[%[' .. old_esc .. '%.md%]%]', '[[' .. new_rel .. '.md]]')
      content = content:gsub('%[%[' .. old_esc .. '%]%]', '[[' .. new_rel .. ']]')
      content = content:gsub('%[%[' .. old_esc .. '|', '[[' .. new_rel .. '|')
      -- ](old_rel.md) markdown link target
      content = content:gsub('%]%(' .. old_esc .. '%.md%)', '](' .. new_rel .. '.md)')
      if content ~= original then
        local out = io.open(file, 'w')
        if out then
          out:write(content)
          out:close()
          changed = changed + 1
        end
      end
    end
  end
  return changed
end

local function do_rename(old_path, new_rel_input)
  if new_rel_input == nil or new_rel_input == '' then return end
  local new_rel = new_rel_input:gsub('%.md$', '')
  local old_rel = rel(old_path)
  if new_rel == old_rel then
    vim.notify('[kra notes] same name; nothing to do', vim.log.levels.INFO)
    return
  end
  local new_path = abs(new_rel)
  if vim.fn.filereadable(new_path) == 1 then
    vim.notify('[kra notes] target already exists: ' .. new_rel, vim.log.levels.ERROR)
    return
  end

  vim.fn.mkdir(vim.fn.fnamemodify(new_path, ':h'), 'p')

  local cur_buf = vim.api.nvim_get_current_buf()
  local cur_buf_path = vim.api.nvim_buf_get_name(cur_buf)
  local was_modified = vim.bo[cur_buf].modified
  if was_modified and cur_buf_path == old_path then
    vim.cmd('silent! write')
  end

  local ok, err = os.rename(old_path, new_path)
  if not ok then
    vim.notify('[kra notes] rename failed: ' .. tostring(err), vim.log.levels.ERROR)
    return
  end

  -- Replace any open buffer pointing at the old path with the new one.
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_buf_get_name(buf) == old_path then
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_buf(win) == buf then
          vim.api.nvim_win_call(win, function() vim.cmd('edit ' .. vim.fn.fnameescape(new_path)) end)
        end
      end
      pcall(vim.api.nvim_buf_delete, buf, { force = true })
    end
  end

  local answer = vim.fn.confirm('Rewrite incoming links to ' .. new_rel .. '?', '&Yes\n&No', 1, 'Question')
  if answer == 1 then
    local n = rewrite_links(old_rel, new_rel)
    vim.notify(string.format('[kra notes] renamed -> %s (%d file%s updated)',
      new_rel, n, n == 1 and '' or 's'))
    vim.cmd('checktime')
  else
    vim.notify('[kra notes] renamed -> ' .. new_rel)
  end
end

local function rename_current()
  local file = vim.fn.expand('%:p')
  if file == '' or not file:match('^' .. vim.pesc(notes_root)) or not file:match('%.md$') then
    vim.notify('[kra notes] not a note buffer', vim.log.levels.WARN)
    return
  end
  vim.ui.input({
    prompt = 'Rename to (relative, no .md): ',
    default = rel(file),
    completion = 'file',
  }, function(input)
    if input then do_rename(file, input) end
  end)
end

function M.setup(root)
  notes_root = root

  vim.api.nvim_create_user_command('KraNotesRename', function(opts)
    if opts.args and opts.args ~= '' then
      local file = vim.fn.expand('%:p')
      if file == '' then
        vim.notify('[kra notes] no current file', vim.log.levels.WARN)
        return
      end
      do_rename(file, opts.args)
    else
      rename_current()
    end
  end, { nargs = '?' })

  local grp = vim.api.nvim_create_augroup('KraNotesRename', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWinEnter' }, {
    group = grp,
    pattern = notes_root .. '/*.md',
    callback = function(args)
      vim.keymap.set('n', '<leader>R', rename_current,
        { buffer = args.buf, nowait = true, silent = true, desc = 'kra notes: rename current note' })
    end,
  })
end

return M
