-- init.lua
-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
    vim.fn.system({
        "git",
        "clone",
        "--filter=blob:none",
        "https://github.com/folke/lazy.nvim.git",
        "--branch=stable",
        lazypath,
    })
end
vim.opt.rtp:prepend(lazypath)

-- Load plugins
require("lazy").setup({
    -- Stunning markdown rendering optimized for chat
    {
        "MeanderingProgrammer/render-markdown.nvim",
        dependencies = {
            "nvim-treesitter/nvim-treesitter",
            "nvim-web-devicons"
        },
        config = function()
            require("render-markdown").setup({
                -- Chat-optimized headings with visual prominence
                headings = {
                    enabled = true,
                    sign = true,
                    icons = { "█ ", "▓ ", "▒ ", "░ ", "▪ ", "▫ " },
                    signs = { "󰫎 " },
                    width = "full",
                    left_pad = 2,
                    right_pad = 6,
                    min_width = 0,
                    border = true,
                    border_virtual = true,
                    above = "▔",
                    below = "▁",
                    backgrounds = {
                        "RenderMarkdownH1Bg",
                        "RenderMarkdownH2Bg",
                        "RenderMarkdownH3Bg",
                        "RenderMarkdownH4Bg",
                        "RenderMarkdownH5Bg",
                        "RenderMarkdownH6Bg",
                    },
                },
                paragraph = {
                    enabled = true,
                    left_margin = 1,
                    min_width = 0,
                },
                code = {
                    enabled = true,
                    sign = true,
                    style = "full",
                    position = "left",
                    language_pad = 2,
                    disable_background = { "diff" },
                    width = "full",
                    left_pad = 2,
                    right_pad = 4,
                    min_width = 0,
                    border = "thick",
                    above = "█",
                    below = "█",
                    highlight = "RenderMarkdownCode",
                    highlight_inline = "RenderMarkdownCodeInline",
                },
                dash = {
                    enabled = true,
                    icon = "━",
                    width = "full",
                    highlight = "RenderMarkdownDash",
                },
                bullet = {
                    enabled = true,
                    icons = { "•", "◦", "▸", "▹" },
                    ordered_icons = { "₁", "₂", "₃", "₄", "₅", "₆" },
                    left_pad = 1,
                    right_pad = 1,
                    highlight = "RenderMarkdownBullet",
                },
                checkbox = {
                    enabled = true,
                    position = "inline",
                    unchecked = {
                        icon = " ",
                        highlight = "RenderMarkdownUnchecked",
                        scope_highlight = "RenderMarkdownUncheckedScope",
                    },
                    checked = {
                        icon = " ",
                        highlight = "RenderMarkdownChecked",
                        scope_highlight = "RenderMarkdownCheckedScope",
                    },
                    custom = {
                        todo = { raw = "[-]", rendered = "󰥔 ", highlight = "RenderMarkdownTodo" },
                        doing = { raw = "[~]", rendered = "󰔟 ", highlight = "RenderMarkdownDoing" },
                        cancelled = { raw = "[x]", rendered = "󰜺 ", highlight = "RenderMarkdownCancelled" },
                    },
                },
                quote = {
                    enabled = true,
                    icon = "▎",
                    repeat_linebreak = false,
                    highlight = "RenderMarkdownQuote",
                },
                pipe_table = {
                    enabled = true,
                    preset = "round",
                    style = "full",
                    cell = "padded",
                    min_width = 0,
                    border = {
                        "╭", "┬", "╮",
                        "├", "┼", "┤",
                        "╰", "┴", "╯",
                        "│", "─",
                    },
                    alignment_indicator = "━",
                    head = "RenderMarkdownTableHead",
                    row = "RenderMarkdownTableRow",
                    filler = "RenderMarkdownTableFill",
                },
                callout = {
                    note = { raw = "[!NOTE]", rendered = "󰋽 Note", highlight = "RenderMarkdownInfo" },
                    tip = { raw = "[!TIP]", rendered = "󰌶 Tip", highlight = "RenderMarkdownSuccess" },
                    important = { raw = "[!IMPORTANT]", rendered = "󰅾 Important", highlight = "RenderMarkdownHint" },
                    warning = { raw = "[!WARNING]", rendered = "󰀪 Warning", highlight = "RenderMarkdownWarn" },
                    caution = { raw = "[!CAUTION]", rendered = "󰳦 Caution", highlight = "RenderMarkdownError" },
                    abstract = { raw = "[!ABSTRACT]", rendered = "󰨸 Abstract", highlight = "RenderMarkdownInfo" },
                    summary = { raw = "[!SUMMARY]", rendered = "󰨸 Summary", highlight = "RenderMarkdownInfo" },
                    info = { raw = "[!INFO]", rendered = "󰋽 Info", highlight = "RenderMarkdownInfo" },
                    todo = { raw = "[!TODO]", rendered = "󰗡 Todo", highlight = "RenderMarkdownTodo" },
                    hint = { raw = "[!HINT]", rendered = "󰌶 Hint", highlight = "RenderMarkdownHint" },
                    success = { raw = "[!SUCCESS]", rendered = "󰄬 Success", highlight = "RenderMarkdownSuccess" },
                    check = { raw = "[!CHECK]", rendered = "󰄬 Check", highlight = "RenderMarkdownSuccess" },
                    done = { raw = "[!DONE]", rendered = "󰄬 Done", highlight = "RenderMarkdownSuccess" },
                    question = { raw = "[!QUESTION]", rendered = "󰘥 Question", highlight = "RenderMarkdownWarn" },
                    help = { raw = "[!HELP]", rendered = "󰘥 Help", highlight = "RenderMarkdownWarn" },
                    faq = { raw = "[!FAQ]", rendered = "󰘥 FAQ", highlight = "RenderMarkdownWarn" },
                    attention = { raw = "[!ATTENTION]", rendered = "󰀪 Attention", highlight = "RenderMarkdownWarn" },
                    failure = { raw = "[!FAILURE]", rendered = "󰅖 Failure", highlight = "RenderMarkdownError" },
                    fail = { raw = "[!FAIL]", rendered = "󰅖 Fail", highlight = "RenderMarkdownError" },
                    missing = { raw = "[!MISSING]", rendered = "󰅖 Missing", highlight = "RenderMarkdownError" },
                    danger = { raw = "[!DANGER]", rendered = "󱐌 Danger", highlight = "RenderMarkdownError" },
                    error = { raw = "[!ERROR]", rendered = "󱐌 Error", highlight = "RenderMarkdownError" },
                    bug = { raw = "[!BUG]", rendered = "󰨰 Bug", highlight = "RenderMarkdownError" },
                    example = { raw = "[!EXAMPLE]", rendered = "󰉹 Example", highlight = "RenderMarkdownHint" },
                    quote = { raw = "[!QUOTE]", rendered = "󱆨 Quote", highlight = "RenderMarkdownQuote" },
                    cite = { raw = "[!CITE]", rendered = "󱆨 Cite", highlight = "RenderMarkdownQuote" },
                },
                link = {
                    enabled = true,
                    image = "󰥶 ",
                    email = "󰀓 ",
                    hyperlink = "󰌹 ",
                    highlight = "RenderMarkdownLink",
                    custom = {
                        web = { pattern = "^http[s]?://", icon = "󰖟 ", highlight = "RenderMarkdownLinkText" },
                        youtube = { pattern = "youtube%.com", icon = "󰗃 ", highlight = "RenderMarkdownError" },
                        github = { pattern = "github%.com", icon = "󰊤 ", highlight = "RenderMarkdownSuccess" },
                    },
                },
                sign = {
                    enabled = true,
                    highlight = "RenderMarkdownSign",
                },
                math = {
                    enabled = true,
                    single_dollar = true,
                    highlight = "RenderMarkdownMath",
                },
                html = {
                    enabled = true,
                    comment = {
                        text = "",
                        highlight = "RenderMarkdownIgnore",
                    },
                },
                latex = {
                    enabled = true,
                    converter = "latex2text",
                    highlight = "RenderMarkdownMath",
                    top_pad = 0,
                    bottom_pad = 0,
                },
            })
        end,
        ft = { "markdown" },
    },

    -- Indent guides for better structure
    {
        "lukas-reineke/indent-blankline.nvim",
        main = "ibl",
        config = function()
            require("ibl").setup({
                indent = {
                    char = "▏",
                    tab_char = "▏",
                },
                scope = {
                    enabled = true,
                    char = "▎",
                    show_start = false,
                    show_end = false,
                    injected_languages = false,
                    highlight = { "Function", "Label" },
                },
                exclude = {
                    filetypes = {
                        "help", "alpha", "dashboard", "neo-tree", "Trouble", "trouble",
                        "lazy", "mason", "notify", "toggleterm", "lazyterm",
                    },
                },
            })
        end,
    },

    -- Smooth scrolling for better chat experience
    {
        "karb94/neoscroll.nvim",
        config = function()
            require('neoscroll').setup({
                mappings = { '<C-u>', '<C-d>', '<C-b>', '<C-f>', '<C-y>', '<C-e>', 'zt', 'zz', 'zb' },
                hide_cursor = true,
                stop_eof = true,
                respect_scrolloff = false,
                cursor_scrolls_alone = true,
                easing_function = "sine",
                pre_hook = nil,
                post_hook = nil,
            })
        end,
    },

    -- Telescope - Essential for file selection
    {
        'nvim-telescope/telescope.nvim',
        tag = '0.1.6',
        dependencies = {
            'nvim-lua/plenary.nvim',
            {
                'nvim-telescope/telescope-fzf-native.nvim',
                build = 'make',
                cond = function()
                    return vim.fn.executable 'make' == 1
                end,
            },
        },
        config = function()
            require('telescope').setup({
                defaults = {
                    mappings = {
                        i = {
                            ['<C-u>'] = false,
                            ['<C-d>'] = false,
                        },
                    },
                    file_ignore_patterns = {
                        "node_modules", ".git/", "dist/", "build/", ".next/",
                        "%.lock", "package%-lock%.json"
                    },
                    layout_config = {
                        horizontal = {
                            preview_width = 0.6,
                        },
                        vertical = {
                            mirror = false,
                        },
                    },
                },
                pickers = {
                    find_files = {
                        theme = "dropdown",
                        previewer = false,
                        hidden = true,
                    },
                },
            })

            -- Enable telescope fzf native, if installed
            pcall(require('telescope').load_extension, 'fzf')
        end,
    },

    -- Better syntax highlighting
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
        config = function()
            require("nvim-treesitter.configs").setup({
                ensure_installed = {
                    "markdown",
                    "markdown_inline",
                    "html",
                    "css",
                    "javascript",
                    "typescript",
                    "python",
                    "lua",
                    "json",
                    "yaml",
                    "bash",
                    "regex",
                },
                highlight = {
                    enable = true,
                    additional_vim_regex_highlighting = false,
                },
                indent = { enable = true },
            })
        end,
    },

    -- Icons for visual appeal
    {
        "nvim-tree/nvim-web-devicons",
        config = function()
            require("nvim-web-devicons").setup({
                override = {
                    md = {
                        icon = "󰍔",
                        color = "#7dcfff",
                        cterm_color = "67",
                        name = "Md",
                    },
                },
                color_icons = true,
                default = true,
                strict = true,
            })
        end,
    },

    -- Status line for chat context
    {
        'nvim-lualine/lualine.nvim',
        dependencies = { 'nvim-tree/nvim-web-devicons' },
        config = function()
            require('lualine').setup {
                options = {
                    icons_enabled = true,
                    theme = 'tokyonight',
                    component_separators = { left = '', right = '' },
                    section_separators = { left = '', right = '' },
                    disabled_filetypes = {
                        statusline = {},
                        winbar = {},
                    },
                    ignore_focus = {},
                    always_divide_middle = true,
                    globalstatus = false,
                    refresh = {
                        statusline = 1000,
                        tabline = 1000,
                        winbar = 1000,
                    }
                },
                sections = {
                    lualine_a = { 'mode' },
                    lualine_b = { 'branch', 'diff', 'diagnostics' },
                    lualine_c = { { 'filename', path = 1 } },
                    lualine_x = { 'encoding', 'fileformat', 'filetype' },
                    lualine_y = { 'progress' },
                    lualine_z = { 'location' }
                },
                inactive_sections = {
                    lualine_a = {},
                    lualine_b = {},
                    lualine_c = { 'filename' },
                    lualine_x = { 'location' },
                    lualine_y = {},
                    lualine_z = {}
                },
                tabline = {},
                winbar = {},
                inactive_winbar = {},
                extensions = {}
            }
        end,
    },
})

-- Optimized settings for chat experience
vim.opt.number = false     -- Clean look for chat
vim.opt.relativenumber = false
vim.opt.wrap = true        -- Better for chat messages
vim.opt.linebreak = true   -- Wrap at word boundaries
vim.opt.breakindent = true -- Maintain indentation on wrapped lines
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.conceallevel = 2     -- Essential for markdown rendering
vim.opt.concealcursor = 'nc' -- Hide markup in normal and command mode
vim.opt.termguicolors = true -- Full color support
vim.opt.pumheight = 15       -- Limit completion menu height
vim.opt.scrolloff = 8        -- Keep context when scrolling
vim.opt.sidescrolloff = 8
vim.opt.cursorline = false   -- Less visual clutter for chat
vim.opt.signcolumn = "no"    -- Clean chat appearance
vim.opt.foldcolumn = "0"
vim.opt.cmdheight = 1
vim.opt.laststatus = 2
vim.opt.showmode = false -- lualine shows mode
vim.opt.ruler = false
vim.opt.showcmd = false

-- Leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Chat-optimized auto-commands
vim.api.nvim_create_autocmd("FileType", {
    pattern = "markdown",
    callback = function()
        vim.opt_local.wrap = true
        vim.opt_local.linebreak = true
        vim.opt_local.conceallevel = 2
        vim.opt_local.concealcursor = 'nc'
        vim.opt_local.spell = false             -- Disable spell check for chat
        vim.opt_local.textwidth = 0             -- No auto line breaks
        vim.opt_local.formatoptions:remove("t") -- Don't auto-wrap text

        -- Smooth scrolling keymaps for chat navigation
        local map = vim.keymap.set
        map('n', 'j', "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })
        map('n', 'k', "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
    end,
})

-- Better folding for long chats
vim.opt.foldmethod = "expr"
vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
vim.opt.foldlevelstart = 99 -- Start with all folds open
vim.opt.foldtext = ""

-- Chat-focused keymaps
local map = vim.keymap.set

-- Quick navigation
map('n', 'J', '5gj', { silent = true, desc = 'Move down 5 lines' })
map('n', 'K', '5gk', { silent = true, desc = 'Move up 5 lines' })
map('n', '<C-d>', '<C-d>zz', { silent = true, desc = 'Scroll down and center' })
map('n', '<C-u>', '<C-u>zz', { silent = true, desc = 'Scroll up and center' })

-- Clipboard functionality
map('n', 'Y', '"+Y', { silent = true, desc = 'Copy line to system clipboard' })
map('v', 'Y', '"+y', { silent = true, desc = 'Copy selection to system clipboard' })
map('n', '<leader>y', '"+y', { silent = true, desc = 'Copy to system clipboard' })
map('v', '<leader>y', '"+y', { silent = true, desc = 'Copy to system clipboard' })
map('n', '<leader>p', '"+p', { silent = true, desc = 'Paste from system clipboard' })

-- Quick folding for managing long conversations
map('n', '<leader>z', 'za', { silent = true, desc = 'Toggle fold' })
map('n', '<leader>Z', 'zA', { silent = true, desc = 'Toggle fold recursively' })

-- Performance optimizations for large chat logs
vim.opt.updatetime = 300
vim.opt.timeoutlen = 500
vim.opt.ttimeoutlen = 0

-- Disable some features that aren't needed for chat viewing
vim.g.loaded_gzip = 1
vim.g.loaded_tar = 1
vim.g.loaded_tarPlugin = 1
vim.g.loaded_zip = 1
vim.g.loaded_zipPlugin = 1
vim.g.loaded_getscript = 1
vim.g.loaded_getscriptPlugin = 1
vim.g.loaded_vimball = 1
vim.g.loaded_vimballPlugin = 1
vim.g.loaded_matchit = 1
vim.g.loaded_matchparen = 1
vim.g.loaded_2html_plugin = 1
vim.g.loaded_logiPat = 1
vim.g.loaded_rrhelper = 1
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1
vim.g.loaded_netrwSettings = 1
vim.g.loaded_netrwFileHandlers = 1

-- Add this section after your plugins setup and before the vim.opt settings
-- Custom markdown colors for easier reading
local function setup_markdown_colors()
    -- Balanced color palette with good contrast and differentiation
    local colors = {
        -- Subtle but visible backgrounds
        bg_h1 = "#2a3441",      -- Distinct blue-gray background
        bg_h2 = "#2d2a3f",      -- Purple-gray background
        bg_h3 = "#2a2d35",      -- Neutral gray background
        bg_code = "#1f2937",    -- Clear dark background for code

        -- Well-contrasted text colors
        heading1 = "#60a5fa",   -- Bright blue for H1
        heading2 = "#a78bfa",   -- Purple for H2
        heading3 = "#34d399",   -- Green for H3
        heading = "#e2e8f0",    -- Light gray for H4-H6
        code = "#fbbf24",       -- Amber for code - very readable
        quote = "#a855f7",      -- Purple for quotes
        bullet = "#10b981",     -- Green for bullets
        link = "#06b6d4",       -- Cyan for links

        -- Clear accent colors
        success = "#10b981",    -- Green
        warning = "#f59e0b",    -- Orange
        error = "#ef4444",      -- Red
        info = "#3b82f6",       -- Blue
    }

    -- Apply the colors with better differentiation
    vim.api.nvim_set_hl(0, "RenderMarkdownH1", { fg = colors.heading1, bold = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownH1Bg", { bg = colors.bg_h1 })
    vim.api.nvim_set_hl(0, "RenderMarkdownH2", { fg = colors.heading2, bold = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownH2Bg", { bg = colors.bg_h2 })
    vim.api.nvim_set_hl(0, "RenderMarkdownH3", { fg = colors.heading3, bold = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownH3Bg", { bg = colors.bg_h3 })
    vim.api.nvim_set_hl(0, "RenderMarkdownH4", { fg = colors.heading })
    vim.api.nvim_set_hl(0, "RenderMarkdownH4Bg", { bg = colors.bg_h3 })
    vim.api.nvim_set_hl(0, "RenderMarkdownH5", { fg = colors.heading })
    vim.api.nvim_set_hl(0, "RenderMarkdownH5Bg", { bg = colors.bg_h3 })
    vim.api.nvim_set_hl(0, "RenderMarkdownH6", { fg = colors.heading })
    vim.api.nvim_set_hl(0, "RenderMarkdownH6Bg", { bg = colors.bg_h3 })

    -- Code styling
    vim.api.nvim_set_hl(0, "RenderMarkdownCode", { bg = colors.bg_code })
    vim.api.nvim_set_hl(0, "RenderMarkdownCodeInline", { fg = colors.code, bg = colors.bg_code })

    -- Other elements
    vim.api.nvim_set_hl(0, "RenderMarkdownQuote", { fg = colors.quote, italic = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownBullet", { fg = colors.bullet })
    vim.api.nvim_set_hl(0, "RenderMarkdownLink", { fg = colors.link, underline = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownLinkText", { fg = colors.link })

    -- Checkboxes
    vim.api.nvim_set_hl(0, "RenderMarkdownChecked", { fg = colors.success })
    vim.api.nvim_set_hl(0, "RenderMarkdownUnchecked", { fg = colors.heading })
    vim.api.nvim_set_hl(0, "RenderMarkdownTodo", { fg = colors.warning })

    -- Table styling
    vim.api.nvim_set_hl(0, "RenderMarkdownTableHead", { fg = colors.heading, bold = true })
    vim.api.nvim_set_hl(0, "RenderMarkdownTableRow", { fg = colors.heading })

    -- Callouts
    vim.api.nvim_set_hl(0, "RenderMarkdownInfo", { fg = colors.info })
    vim.api.nvim_set_hl(0, "RenderMarkdownSuccess", { fg = colors.success })
    vim.api.nvim_set_hl(0, "RenderMarkdownWarn", { fg = colors.warning })
    vim.api.nvim_set_hl(0, "RenderMarkdownError", { fg = colors.error })
    vim.api.nvim_set_hl(0, "RenderMarkdownHint", { fg = colors.info })

    -- Reduce visual noise but keep it visible
    vim.api.nvim_set_hl(0, "RenderMarkdownDash", { fg = "#6b7280" }) -- Visible but muted separator
    vim.api.nvim_set_hl(0, "RenderMarkdownSign", { fg = "#6b7280" }) -- Visible signs
end

-- Apply colors after colorscheme loads
vim.api.nvim_create_autocmd("ColorScheme", {
    pattern = "*",
    callback = setup_markdown_colors,
})

-- Apply colors immediately
setup_markdown_colors()
