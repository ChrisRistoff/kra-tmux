-- kra notes: daily journal. Notes under <root>/journal/YYYY/MM/YYYY-MM-DD.md
local M = {}

local function journal_path(notes_root, date)
  local y = os.date('%Y', date)
  local m = os.date('%m', date)
  local d = os.date('%Y-%m-%d', date)
  return notes_root .. '/journal/' .. y .. '/' .. m .. '/' .. d .. '.md'
end

local function open_journal(notes_root, date)
  local file = journal_path(notes_root, date)
  vim.fn.mkdir(vim.fn.fnamemodify(file, ':h'), 'p')
  if vim.fn.filereadable(file) == 0 then
    local nice = os.date('%A, %B %d %Y', date)
    local iso  = os.date('%Y-%m-%d', date)
    vim.fn.writefile({
      '---',
      'created: ' .. iso,
      'tags: [journal]',
      '---',
      '',
      '# ' .. nice,
      '',
      '## Notes',
      '',
      '## Tasks',
      '',
      '- [ ] ',
      '',
    }, file)
  end
  vim.cmd('edit ' .. vim.fn.fnameescape(file))
end

function M.setup(notes_root)
  vim.keymap.set('n', '<leader>j', function()
    open_journal(notes_root, os.time())
  end, { desc = 'kra notes: journal today' })

  vim.keymap.set('n', '<leader>J', function()
    require('telescope.builtin').find_files({
      cwd = notes_root .. '/journal',
      prompt_title = 'Journal entries',
    })
  end, { desc = 'kra notes: journal picker' })

  vim.api.nvim_create_user_command('KraNotesJournal', function(opts)
    local arg = opts.args
    local t = os.time()
    if arg == '' or arg == 'today' then
      -- nothing
    elseif arg == 'yesterday' then
      t = t - 86400
    elseif arg == 'tomorrow' then
      t = t + 86400
    else
      local y, m, d = arg:match('^(%d%d%d%d)%-(%d%d)%-(%d%d)$')
      if y then
        t = os.time({ year = tonumber(y), month = tonumber(m), day = tonumber(d), hour = 12 })
      else
        print('[kra notes] unrecognized journal date: ' .. arg)
        return
      end
    end
    open_journal(notes_root, t)
  end, { nargs = '?' })
end

return M
