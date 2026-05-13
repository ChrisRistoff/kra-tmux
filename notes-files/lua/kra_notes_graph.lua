-- kra notes: ASCII outgoing-link tree + backlinks for the current note.
-- Press <leader>G to open. <CR> opens the note under cursor in the previous
-- window, <Tab> expands/collapses, q closes, gv/gs open in vsplit/hsplit.

local M = {}

local notes_root
local MAX_DEPTH_DEFAULT = 3

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

-- Build adjacency map: { [relpath] = { outgoing = { rel, ... }, incoming = {...} } }
local function build_graph()
  local graph = {}
  local function ensure(node) graph[node] = graph[node] or { outgoing = {}, incoming = {}, seen_out = {}, seen_in = {} } end

  local files = vim.fn.systemlist({ 'rg', '--files', '--type-add', 'md:*.md', '--type', 'md', '--glob', '!**/.nvim-data/**', notes_root })
  if vim.v.shell_error ~= 0 then
    files = vim.fn.systemlist({ 'find', notes_root, '-type', 'f', '-name', '*.md', '-not', '-path', '*/.nvim-data/*' })
  end

  for _, file in ipairs(files) do
    local from = rel(file)
    ensure(from)
    local lines = {}
    local fh = io.open(file, 'r')
    if fh then
      for l in fh:lines() do table.insert(lines, l) end
      fh:close()
    end
    for _, line in ipairs(lines) do
      for target in line:gmatch('%[%[([^%]]+)%]%]') do
        local t = target:gsub('%.md$', '')
        ensure(t)
        if not graph[from].seen_out[t] then
          graph[from].seen_out[t] = true
          table.insert(graph[from].outgoing, t)
        end
        if not graph[t].seen_in[from] then
          graph[t].seen_in[from] = true
          table.insert(graph[t].incoming, from)
        end
      end
      for _, target in line:gmatch('%[([^%]]-)%]%(([^)]+)%)') do
        if not target:match('^https?://') and not target:match('^mailto:') then
          local t = target:gsub('%.md$', ''):gsub('^%./', '')
          ensure(t)
          if not graph[from].seen_out[t] then
            graph[from].seen_out[t] = true
            table.insert(graph[from].outgoing, t)
          end
          if not graph[t].seen_in[from] then
            graph[t].seen_in[from] = true
            table.insert(graph[t].incoming, from)
          end
        end
      end
    end
  end

  return graph
end

local state = {} -- { lines = {{text, target, depth}}, graph, root, max_depth, prev_win, graph_win, graph_buf }

local function expand(root, depth, max_depth, visited, out)
  local node = state.graph[root] or { outgoing = {}, incoming = {} }
  local outc = #node.outgoing
  local inc  = #node.incoming
  local marker = ''
  if visited[root] then marker = ' (cycle)' end
  local annotation = string.format('  (%d\u{2197}  %d\u{2199})', outc, inc)
  local prefix = string.rep('  ', depth) .. (depth == 0 and '' or '\u{2502} ')
  table.insert(out, { text = prefix .. root .. annotation .. marker, target = root, depth = depth })
  if visited[root] then return end
  if depth >= max_depth then
    if outc > 0 then
      table.insert(out, { text = string.rep('  ', depth + 1) .. '\u{2026} (' .. outc .. ' more, expand)', target = nil, depth = depth + 1 })
    end
    return
  end
  visited[root] = true
  for _, child in ipairs(node.outgoing) do
    expand(child, depth + 1, max_depth, visited, out)
  end
  visited[root] = nil
end

local function render(root, max_depth, prev_win)
  local graph = build_graph()
  state = {
    lines = {},
    graph = graph,
    root = root,
    max_depth = max_depth,
    prev_win = prev_win,
  }

  table.insert(state.lines, { text = '\u{1F4DD} kra notes graph  \u{2014}  root: ' .. root, target = nil, depth = 0 })
  table.insert(state.lines, { text = '   <CR> open  <Tab> expand deeper  gv/gs split  q close', target = nil, depth = 0 })
  table.insert(state.lines, { text = '', target = nil, depth = 0 })
  table.insert(state.lines, { text = '\u{25BE} Outgoing (depth ' .. max_depth .. ')', target = nil, depth = 0 })
  expand(root, 0, max_depth, {}, state.lines)

  local incoming = (graph[root] or {}).incoming or {}
  table.insert(state.lines, { text = '', target = nil, depth = 0 })
  table.insert(state.lines, { text = '\u{25C2} Backlinks (' .. #incoming .. ')', target = nil, depth = 0 })
  if #incoming == 0 then
    table.insert(state.lines, { text = '   (none)', target = nil, depth = 0 })
  else
    for _, src in ipairs(incoming) do
      local outc = #(graph[src] and graph[src].outgoing or {})
      table.insert(state.lines, {
        text = '  \u{2502} ' .. src .. string.format('  (%d\u{2197})', outc),
        target = src,
        depth = 1,
      })
    end
  end

  -- Find or create the graph buffer
  local bufname = 'kra://notes-graph'
  local buf = vim.fn.bufnr(bufname)
  if buf == -1 then
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, bufname)
  end
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = true

  local text_lines = {}
  for _, l in ipairs(state.lines) do table.insert(text_lines, l.text) end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, text_lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = 'kra-notes-graph'

  -- Open in a right-side split if not already shown
  local win = nil
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(w) == buf then win = w; break end
  end
  if not win then
    vim.cmd('botright vsplit')
    vim.api.nvim_win_set_width(0, math.max(50, math.floor(vim.o.columns * 0.4)))
    vim.api.nvim_win_set_buf(0, buf)
    win = vim.api.nvim_get_current_win()
  else
    vim.api.nvim_set_current_win(win)
  end
  vim.wo[win].wrap = false
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  vim.wo[win].cursorline = true
  state.graph_win = win
  state.graph_buf = buf

  vim.api.nvim_create_autocmd('BufWipeout', {
    buffer = buf,
    once = true,
    callback = function()
      state.graph_win = nil
      state.graph_buf = nil
    end,
  })

  -- Buffer-local keymaps
  local function target_under_cursor()
    local row = vim.api.nvim_win_get_cursor(0)[1]
    local entry = state.lines[row]
    return entry and entry.target or nil
  end

  local function open_in(cmd)
    local t = target_under_cursor()
    if not t then return end
    local file = abs(t)
    vim.fn.mkdir(vim.fn.fnamemodify(file, ':h'), 'p')
    local target_win = state.prev_win
    if target_win and vim.api.nvim_win_is_valid(target_win) then
      vim.api.nvim_set_current_win(target_win)
    else
      vim.cmd('wincmd p')
    end
    vim.cmd(cmd .. ' ' .. vim.fn.fnameescape(file))
  end

  local opts = { buffer = buf, nowait = true, silent = true }
  vim.keymap.set('n', '<CR>', function() open_in('edit') end, opts)
  vim.keymap.set('n', 'gv',   function() open_in('vsplit') end, opts)
  vim.keymap.set('n', 'gs',   function() open_in('split') end, opts)
  vim.keymap.set('n', 'q',    function() vim.cmd('quit') end, opts)
  vim.keymap.set('n', '<Tab>', function()
    -- Re-render with depth +1
    render(state.root, state.max_depth + 1, state.prev_win)
  end, opts)
  vim.keymap.set('n', '<S-Tab>', function()
    render(state.root, math.max(1, state.max_depth - 1), state.prev_win)
  end, opts)
  vim.keymap.set('n', 'r', function()
    render(state.root, state.max_depth, state.prev_win)
  end, opts)
end

function M.setup(root)
  notes_root = root

  -- In any note buffer, <Tab> jumps back to the graph sidebar when it's open.
  -- Falls through to the default <C-i> jump otherwise so the jumplist still works.
  local function focus_graph_or_jump()
    if state.graph_win and vim.api.nvim_win_is_valid(state.graph_win) then
      vim.api.nvim_set_current_win(state.graph_win)
    else
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-i>', true, false, true), 'n', false)
    end
  end

  local grp = vim.api.nvim_create_augroup('KraNotesGraphTab', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWinEnter' }, {
    group = grp,
    pattern = notes_root .. '/*.md',
    callback = function(args)
      vim.keymap.set('n', '<Tab>', focus_graph_or_jump,
        { buffer = args.buf, nowait = true, silent = true, desc = 'kra notes: focus link graph' })
    end,
  })
  vim.keymap.set('n', '<leader>G', function()
    local file = vim.fn.expand('%:p')
    local current
    if file == '' or not file:match('^' .. vim.pesc(notes_root)) then
      current = 'index'
    else
      current = rel(file)
    end
    local prev_win = vim.api.nvim_get_current_win()
    render(current, MAX_DEPTH_DEFAULT, prev_win)
  end, { desc = 'kra notes: link graph' })

  vim.api.nvim_create_user_command('KraNotesGraph', function(opts)
    local root = opts.args ~= '' and opts.args or 'index'
    local prev_win = vim.api.nvim_get_current_win()
    render(root, MAX_DEPTH_DEFAULT, prev_win)
  end, { nargs = '?' })
end

return M
