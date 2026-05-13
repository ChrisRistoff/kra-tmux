-- kra notes: self-contained nvim config for the markdown note app.
-- Bootstraps lazy.nvim into ~/.kra/notes/.nvim-data and loads everything
-- needed for in-buffer markdown rendering, telescope, treesitter,
-- and the kra-notes keymaps. Isolated from the user's regular nvim config.

local function notes_root()
  local kra_home = os.getenv('KRA_HOME')
  if kra_home and #kra_home > 0 then
    return kra_home .. '/notes'
  end
  return os.getenv('HOME') .. '/.kra/notes'
end

local NOTES_ROOT = notes_root()
local DATA_DIR   = NOTES_ROOT .. '/.nvim-data'
local LAZY_DIR   = DATA_DIR .. '/lazy'
local LAZY_PATH  = LAZY_DIR .. '/lazy.nvim'

vim.fn.mkdir(NOTES_ROOT, 'p')
vim.fn.mkdir(DATA_DIR, 'p')
vim.fn.mkdir(LAZY_DIR, 'p')

-- Leader must be set BEFORE plugins load.
vim.g.mapleader      = ' '
vim.g.maplocalleader = ' '

-- Bootstrap lazy.nvim
if not vim.loop.fs_stat(LAZY_PATH) then
  print('[kra notes] bootstrapping lazy.nvim...')
  vim.fn.system({
    'git', 'clone', '--filter=blob:none', '--branch=stable',
    'https://github.com/folke/lazy.nvim.git',
    LAZY_PATH,
  })
end
vim.opt.rtp:prepend(LAZY_PATH)

-- Make our own lua/ subtree available.
local SCRIPT_DIR = vim.fn.fnamemodify(vim.fn.expand('<sfile>:p'), ':h')
package.path = SCRIPT_DIR .. '/lua/?.lua;' .. package.path

-- General editor settings tuned for note-taking.
vim.opt.number         = true
vim.opt.relativenumber = false
vim.opt.wrap           = true
vim.opt.linebreak      = true
vim.opt.breakindent    = true
vim.opt.conceallevel   = 2
vim.opt.concealcursor  = 'nc'
vim.opt.expandtab      = true
vim.opt.shiftwidth     = 2
vim.opt.tabstop        = 2
vim.opt.softtabstop    = 2
vim.opt.signcolumn     = 'no'
vim.opt.swapfile       = false
vim.opt.undofile       = true
vim.opt.termguicolors  = true
vim.opt.cmdheight      = 1
vim.opt.laststatus     = 2
vim.opt.mouse          = 'a'
vim.opt.clipboard      = 'unnamedplus'

-- All relative paths resolve to the notes root.
vim.cmd('cd ' .. vim.fn.fnameescape(NOTES_ROOT))

-- Auto-save on focus lost / buffer leave.
vim.api.nvim_create_autocmd({ 'FocusLost', 'BufLeave' }, {
  pattern = '*.md',
  callback = function()
    if vim.bo.modified and vim.bo.buftype == '' and vim.fn.expand('%') ~= '' then
      vim.cmd('silent! write')
    end
  end,
})

-- Plugin spec.
require('lazy').setup({
  {
    'folke/tokyonight.nvim',
    priority = 1000,
    config = function()
      vim.cmd.colorscheme('tokyonight-night')
    end,
  },
  {
    'nvim-treesitter/nvim-treesitter',
    branch = 'master',
    build = ':TSUpdate',
    config = function()
      local ok, ts_configs = pcall(require, 'nvim-treesitter.configs')
      if not ok then return end
      ts_configs.setup({
        ensure_installed = { 'markdown', 'markdown_inline', 'lua', 'vim', 'bash', 'json', 'yaml' },
        highlight = { enable = true },
      })
    end,
  },
  {
    'MeanderingProgrammer/render-markdown.nvim',
    dependencies = { 'nvim-treesitter/nvim-treesitter' },
    ft = { 'markdown' },
    opts = {
      heading = { width = 'block', position = 'inline' },
      code = { width = 'block', sign = false },
      checkbox = {
        unchecked = { icon = '󰄱 ' },
        checked   = { icon = '󰱒 ' },
      },
    },
  },
  { 'nvim-lua/plenary.nvim', lazy = true },
  { 'nvim-tree/nvim-web-devicons', lazy = true },
  { 'MunifTanjim/nui.nvim', lazy = true },
  {
    'folke/noice.nvim',
    event = 'VeryLazy',
    dependencies = { 'MunifTanjim/nui.nvim' },
    opts = {
      cmdline = {
        enabled = true,
        view = 'cmdline_popup',
      },
      messages = {
        enabled = true,
        view = 'mini',
        view_error = 'mini',
        view_warn = 'mini',
        view_history = 'messages',
        view_search = false,
      },
      popupmenu = { enabled = true, backend = 'nui' },
      lsp = {
        override = {
          ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
          ['vim.lsp.util.stylize_markdown'] = true,
        },
      },
      presets = {
        bottom_search = false,
        command_palette = true,
        long_message_to_split = true,
        inc_rename = false,
        lsp_doc_border = true,
      },
      views = {
        cmdline_popup = {
          position = { row = '40%', col = '50%' },
          size = { width = 80, height = 'auto' },
          border = { style = 'rounded' },
        },
        popupmenu = {
          relative = 'editor',
          position = { row = '50%', col = '50%' },
          size = { width = 80, height = 10 },
          border = { style = 'rounded' },
        },
      },
    },
  },
  {
    'folke/which-key.nvim',
    event = 'VeryLazy',
    opts = {
      preset = 'modern',
      delay = 300,
      win = { border = 'rounded' },
      icons = { mappings = false },
      spec = {
        { '<leader>f', desc = 'find note' },
        { '<leader>g', desc = 'live grep' },
        { '<leader>n', desc = 'new note' },
        { '<leader>v', desc = 'open in vsplit' },
        { '<leader>s', desc = 'open in hsplit' },
        { '<leader>q', desc = 'close buffer / quit' },
        { '<leader>l', desc = 'insert link' },
        { '<leader>b', desc = 'backlinks' },
        { '<leader>j', desc = 'journal today' },
        { '<leader>J', desc = 'journal pick' },
        { '<leader>G', desc = 'link graph' },
        { '<leader>X', desc = 'delete note' },
        { '<leader>R', desc = 'rename note' },
        { '<leader>t', desc = 'insert task' },
        { '<leader>x', desc = 'toggle task done' },
        { '<leader>d', desc = 'insert date' },
        { '<leader>D', desc = 'insert datetime' },
        { '<leader>h', desc = 'insert heading' },
        { '<leader>c', desc = 'insert code block' },
        { '<leader>u', desc = 'bullet item' },
        { '<leader>o', desc = 'ordered item' },
        { '<leader>r', desc = 'horizontal rule' },
        { '<leader>m', desc = 'edit frontmatter' },
        { '<leader>+', desc = 'add tag' },
        { '<leader>*', desc = 'wrap bold', mode = { 'v', 'i' } },
        { '<leader>_', desc = 'wrap italic', mode = { 'v', 'i' } },
        { '<leader>k', desc = 'wrap inline code', mode = { 'v', 'i' } },
        { '<leader>"', desc = 'blockquote', mode = 'v' },
      },
    },
  },
  {
    'nvim-telescope/telescope.nvim',
    dependencies = { 'nvim-lua/plenary.nvim', 'nvim-tree/nvim-web-devicons' },
    lazy = false,
    priority = 900,
    config = function()
      local has_rg = vim.fn.executable('rg') == 1
      local pickers = {}
      if has_rg then
        pickers.find_files = {
          hidden = false,
          no_ignore = false,
          find_command = { 'rg', '--files', '--glob', '!**/.nvim-data/**' },
        }
        pickers.live_grep = {
          additional_args = function() return { '--glob', '!**/.nvim-data/**' } end,
        }
      else
        pickers.find_files = { hidden = false, no_ignore = false }
      end
      require('telescope').setup({
        defaults = {
          path_display = { 'truncate' },
          layout_strategy = 'horizontal',
          layout_config = { horizontal = { preview_width = 0.55 } },
          sorting_strategy = 'ascending',
          prompt_prefix = '  ',
          selection_caret = '  ',
          file_ignore_patterns = { '%.nvim%-data/' },
        },
        pickers = pickers,
      })
    end,
  },
}, {
  root = LAZY_DIR,
  lockfile = LAZY_DIR .. '/lazy-lock.json',
  install = { colorscheme = { 'tokyonight-night', 'habamax' } },
  ui = { border = 'rounded' },
  performance = {
    rtp = {
      reset = true,
      disabled_plugins = { 'gzip', 'tarPlugin', 'tohtml', 'tutor', 'zipPlugin', 'netrwPlugin' },
    },
  },
})

-- Load kra notes modules.
require('kra_notes_keymaps').setup(NOTES_ROOT)
require('kra_notes_inserts').setup()
require('kra_notes_links').setup(NOTES_ROOT)
require('kra_notes_backlinks').setup(NOTES_ROOT)
require('kra_notes_journal').setup(NOTES_ROOT)
require('kra_notes_graph').setup(NOTES_ROOT)
require('kra_notes_delete').setup(NOTES_ROOT)
require('kra_notes_rename').setup(NOTES_ROOT)

-- :KraNotesPicker entrypoint used when invoked with no file arg.
vim.api.nvim_create_user_command('KraNotesPicker', function()
  local ok = pcall(require, 'telescope')
  if not ok then
    print('[kra notes] telescope not yet installed; run :Lazy sync then retry')
    return
  end
  require('telescope.builtin').find_files({ cwd = NOTES_ROOT })
end, {})
