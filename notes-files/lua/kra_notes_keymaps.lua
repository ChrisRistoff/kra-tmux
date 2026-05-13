-- kra notes: keymap setup. Leader is space.
local M = {}

function M.setup(notes_root)
  local map = vim.keymap.set

  -- ── File navigation ────────────────────────────────────────────────
  map('n', '<leader>f', function()
    require('telescope.builtin').find_files({ cwd = notes_root })
  end, { desc = 'kra notes: find file' })

  map('n', '<leader>g', function()
    require('telescope.builtin').live_grep({ cwd = notes_root })
  end, { desc = 'kra notes: live grep' })

  map('n', '<leader>n', function()
    vim.ui.input({ prompt = 'New note (e.g. work/idea-x): ' }, function(input)
      if not input or input == '' then return end
      local rel = input:gsub('%.md$', '') .. '.md'
      local full = notes_root .. '/' .. rel
      vim.fn.mkdir(vim.fn.fnamemodify(full, ':h'), 'p')
      if vim.fn.filereadable(full) == 0 then
        local title = vim.fn.fnamemodify(full, ':t:r'):gsub('[-_]', ' ')
        local date  = os.date('%Y-%m-%d')
        vim.fn.writefile({ '---', 'created: ' .. date, 'tags: []', '---', '', '# ' .. title, '' }, full)
      end
      vim.cmd('edit ' .. vim.fn.fnameescape(full))
    end)
  end, { desc = 'kra notes: new note' })

  map('n', '<leader>v', function()
    require('telescope.builtin').find_files({
      cwd = notes_root,
      attach_mappings = function(_, lmap)
        local actions = require('telescope.actions')
        actions.select_default:replace(actions.select_vertical)
        lmap('i', '<CR>', actions.select_vertical)
        lmap('n', '<CR>', actions.select_vertical)
        return true
      end,
    })
  end, { desc = 'kra notes: open in vsplit' })

  map('n', '<leader>s', function()
    require('telescope.builtin').find_files({
      cwd = notes_root,
      attach_mappings = function(_, lmap)
        local actions = require('telescope.actions')
        actions.select_default:replace(actions.select_horizontal)
        lmap('i', '<CR>', actions.select_horizontal)
        lmap('n', '<CR>', actions.select_horizontal)
        return true
      end,
    })
  end, { desc = 'kra notes: open in hsplit' })

  -- ── Buffer navigation ──────────────────────────────────────────────
  map('n', '<BS>', '<cmd>bprev<cr>', { desc = 'kra notes: prev buffer' })
  map('n', '<leader>q', function()
    local bufs = vim.fn.getbufinfo({ buflisted = 1 })
    if #bufs <= 1 then
      vim.cmd('quit')
    else
      vim.cmd('bdelete')
    end
  end, { desc = 'kra notes: close buffer / quit' })
end

return M
