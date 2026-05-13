-- kra notes: insert-element keymaps. All under <leader>.
local M = {}

-- Insert text at cursor in normal mode (cursor lands at end of inserted text in insert mode).
local function insert_at_cursor(text, enter_insert)
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  vim.api.nvim_buf_set_text(0, row - 1, col, row - 1, col, { text })
  vim.api.nvim_win_set_cursor(0, { row, col + #text })
  if enter_insert then
    vim.cmd('startinsert')
    -- Move past the inserted text
    vim.api.nvim_win_set_cursor(0, { row, col + #text })
  end
end

-- Replace current line content with `text`.
local function set_line(text)
  local row = vim.api.nvim_win_get_cursor(0)[1]
  vim.api.nvim_buf_set_lines(0, row - 1, row, false, { text })
end

-- Wrap visual selection with prefix/suffix.
local function wrap_selection(prefix, suffix)
  local s_row, s_col = unpack(vim.api.nvim_buf_get_mark(0, '<'))
  local e_row, e_col = unpack(vim.api.nvim_buf_get_mark(0, '>'))
  -- Adjust end col for inclusive selection.
  local lines = vim.api.nvim_buf_get_lines(0, s_row - 1, e_row, false)
  if #lines == 0 then return end
  if #lines == 1 then
    local line = lines[1]
    local before = line:sub(1, s_col)
    local mid    = line:sub(s_col + 1, e_col + 1)
    local after  = line:sub(e_col + 2)
    vim.api.nvim_buf_set_lines(0, s_row - 1, s_row, false, { before .. prefix .. mid .. suffix .. after })
  else
    lines[1] = lines[1]:sub(1, s_col) .. prefix .. lines[1]:sub(s_col + 1)
    lines[#lines] = lines[#lines]:sub(1, e_col + 1) .. suffix .. lines[#lines]:sub(e_col + 2)
    vim.api.nvim_buf_set_lines(0, s_row - 1, e_row, false, lines)
  end
end

function M.setup()
  local map = vim.keymap.set

  -- ── Tasks ──────────────────────────────────────────────────────────
  map('n', '<leader>t', function()
    insert_at_cursor('- [ ] ', true)
  end, { desc = 'kra notes: insert task' })

  map('n', '<leader>x', function()
    local row = vim.api.nvim_win_get_cursor(0)[1]
    local line = vim.api.nvim_get_current_line()
    if line:match('%[ %]') then
      set_line((line:gsub('%[ %]', '[x]', 1)))
    elseif line:match('%[x%]') then
      set_line((line:gsub('%[x%]', '[ ]', 1)))
    elseif line:match('%[X%]') then
      set_line((line:gsub('%[X%]', '[ ]', 1)))
    end
    vim.api.nvim_win_set_cursor(0, { row, 0 })
  end, { desc = 'kra notes: toggle task done' })

  -- ── Date / time ────────────────────────────────────────────────────
  map('n', '<leader>d', function()
    insert_at_cursor(os.date('%Y-%m-%d'), false)
  end, { desc = 'kra notes: insert date' })

  map('n', '<leader>D', function()
    insert_at_cursor(os.date('%Y-%m-%d %H:%M'), false)
  end, { desc = 'kra notes: insert datetime' })

  -- ── Heading ────────────────────────────────────────────────────────
  map('n', '<leader>h', function()
    vim.ui.input({ prompt = 'Heading level (1-6): ', default = '2' }, function(input)
      if not input then return end
      local level = tonumber(input) or 2
      if level < 1 then level = 1 end
      if level > 6 then level = 6 end
      local row = vim.api.nvim_win_get_cursor(0)[1]
      vim.api.nvim_buf_set_lines(0, row - 1, row - 1, false, { string.rep('#', level) .. ' ' })
      vim.api.nvim_win_set_cursor(0, { row, level + 1 })
      vim.cmd('startinsert!')
    end)
  end, { desc = 'kra notes: insert heading' })

  -- ── Code block ─────────────────────────────────────────────────────
  map('n', '<leader>c', function()
    vim.ui.input({ prompt = 'Code language: ', default = '' }, function(lang)
      if lang == nil then return end
      local row = vim.api.nvim_win_get_cursor(0)[1]
      local block = { '```' .. lang, '', '```' }
      vim.api.nvim_buf_set_lines(0, row, row, false, block)
      vim.api.nvim_win_set_cursor(0, { row + 2, 0 })
      vim.cmd('startinsert')
    end)
  end, { desc = 'kra notes: insert code block' })

  -- ── Lists ──────────────────────────────────────────────────────────
  map('n', '<leader>u', function()
    insert_at_cursor('- ', true)
  end, { desc = 'kra notes: insert bullet' })

  map('n', '<leader>o', function()
    -- Continue numbering if previous line is "<n>. ..."
    local row = vim.api.nvim_win_get_cursor(0)[1]
    local prev = row > 1 and vim.api.nvim_buf_get_lines(0, row - 2, row - 1, false)[1] or ''
    local n = tonumber((prev or ''):match('^(%d+)%.%s'))
    local next_n = (n or 0) + 1
    insert_at_cursor(next_n .. '. ', true)
  end, { desc = 'kra notes: insert ordered list item' })

  map('n', '<leader>r', function()
    local row = vim.api.nvim_win_get_cursor(0)[1]
    vim.api.nvim_buf_set_lines(0, row, row, false, { '', '---', '' })
    vim.api.nvim_win_set_cursor(0, { row + 3, 0 })
  end, { desc = 'kra notes: insert horizontal rule' })

  -- ── Wrap-selection inserts (visual mode) ───────────────────────────
  map('v', '<leader>*', function() wrap_selection('**', '**') end, { desc = 'kra notes: wrap bold' })
  map('v', '<leader>_', function() wrap_selection('*', '*') end, { desc = 'kra notes: wrap italic' })
  map('v', '<leader>k', function() wrap_selection('`', '`') end, { desc = 'kra notes: wrap inline code' })
  map('v', '<leader>"', function() wrap_selection('> ', '') end, { desc = 'kra notes: wrap blockquote' })

  -- Normal-mode wrap shortcuts that drop into insert between markers
  map('n', '<leader>*', function() insert_at_cursor('****', false); vim.cmd('normal! hh'); vim.cmd('startinsert') end, { desc = 'kra notes: bold pair' })
  map('n', '<leader>_', function() insert_at_cursor('**', false); vim.cmd('normal! h'); vim.cmd('startinsert') end, { desc = 'kra notes: italic pair' })
  map('n', '<leader>k', function() insert_at_cursor('``', false); vim.cmd('normal! h'); vim.cmd('startinsert') end, { desc = 'kra notes: inline code pair' })

  -- ── Frontmatter / tags ─────────────────────────────────────────────
  map('n', '<leader>m', function()
    local lines = vim.api.nvim_buf_get_lines(0, 0, 4, false)
    if lines[1] == '---' then
      -- Jump to inside existing frontmatter
      vim.api.nvim_win_set_cursor(0, { 2, 0 })
    else
      local date = os.date('%Y-%m-%d')
      vim.api.nvim_buf_set_lines(0, 0, 0, false, { '---', 'created: ' .. date, 'tags: []', '---', '' })
      vim.api.nvim_win_set_cursor(0, { 3, 7 })
      vim.cmd('startinsert')
    end
  end, { desc = 'kra notes: edit frontmatter' })

  map('n', '<leader>+', function()
    vim.ui.input({ prompt = 'Add tag: ' }, function(tag)
      if not tag or tag == '' then return end
      local lines = vim.api.nvim_buf_get_lines(0, 0, 20, false)
      for i, line in ipairs(lines) do
        local existing = line:match('^tags:%s*%[(.-)%]')
        if existing ~= nil then
          local new = existing == '' and tag or (existing .. ', ' .. tag)
          vim.api.nvim_buf_set_lines(0, i - 1, i, false, { 'tags: [' .. new .. ']' })
          return
        end
      end
      print('[kra notes] no `tags: [...]` line in frontmatter; run <leader>m first')
    end)
  end, { desc = 'kra notes: add tag' })
end

return M
