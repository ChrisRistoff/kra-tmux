# 📝 Notes

A self-contained markdown note app built on top of Neovim with a bundled config — no extra setup required.

## Usage

```bash
kra notes                 # open the fuzzy notes picker
kra notes <name>          # open (or create) ~/.kra/notes/<name>.md
kra notes <cat>/<name>    # categories are just subdirectories
kra notes new <name>      # explicit create with seeded frontmatter
kra notes pick            # same as bare `kra notes`
kra notes journal         # today's journal entry (auto-seeded)
kra notes journal yesterday
kra notes journal 2025-01-15
```

Inside tmux: press `prefix o` to open the notes app in a centered popup (~90% of the screen). Because it's a popup, you can summon it from anywhere in any tmux session — pop it open over whatever you're working on, jot something down, hit `q`, and you're right back where you were. Outside tmux it just runs in the current terminal.

All notes live under `~/.kra/notes/`. Sub-directories act as categories — they are auto-created on demand.

## What's bundled

The first run installs (into `~/.kra/notes/.nvim-data/`, isolated from your normal Neovim config):

- `MeanderingProgrammer/render-markdown.nvim` — in-buffer markdown rendering (headings, code blocks, checkboxes…)
- `nvim-telescope/telescope.nvim` — fuzzy file picker, live grep, backlinks viewer
- `nvim-treesitter/nvim-treesitter` — syntax highlighting for markdown and code blocks
- `folke/tokyonight.nvim` — dark theme
- `folke/which-key.nvim` — popup that shows every `<leader>` keymap with a description as you type

Notes auto-save on `FocusLost` / `BufLeave`.

## Keymaps (leader = `<Space>`)

### Navigation

| Keys           | Action                                              |
| -------------- | --------------------------------------------------- |
| `<leader>f`    | Find note (Telescope `find_files`)                  |
| `<leader>g`    | Live grep across notes                              |
| `<leader>n`    | Prompt for new note name, create + open             |
| `<leader>v`    | Open picked note in vertical split                  |
| `<leader>s`    | Open picked note in horizontal split                |
| `<leader>q`    | Close buffer (or quit if it's the last)             |
| `<leader>j`    | Open today's journal entry                          |
| `<leader>J`    | Pick a past journal entry                           |
| `<BS>`         | Previous buffer                                     |
| `<CR>` / `gf`  | Follow `[[wiki-link]]` or `[text](path)` under cursor |
| `<C-]>`        | Same as `<CR>` (also works from insert mode)        |

### Inserts

| Keys              | Action                                            |
| ----------------- | ------------------------------------------------- |
| `<leader>t`       | Insert task `- [ ] `                              |
| `<leader>x`       | Toggle task done/undone on current line           |
| `<leader>d`       | Insert today's date `YYYY-MM-DD`                  |
| `<leader>D`       | Insert datetime `YYYY-MM-DD HH:MM`                |
| `<leader>h`       | Insert heading (prompts for level 1–6)            |
| `<leader>c`       | Insert fenced code block (prompts for language)   |
| `<leader>u`       | Insert bullet `- `                                |
| `<leader>o`       | Insert ordered list item (continues numbering)    |
| `<leader>r`       | Insert horizontal rule `---`                      |
| `<leader>l`       | Insert link to another note (Telescope picker)    |
| `<leader>*` (v)   | Wrap selection with `**bold**`                    |
| `<leader>_` (v)   | Wrap selection with `*italic*`                    |
| `<leader>k` (v)   | Wrap selection with `` `inline code` ``           |
| `<leader>"` (v)   | Prefix selection with `> ` (blockquote)           |

### Metadata

| Keys           | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `<leader>m`    | Edit frontmatter (creates one if missing)               |
| `<leader>+`    | Add a tag to the frontmatter `tags: [...]` line         |
| `<leader>b`    | Backlinks — references to the current note (Telescope)  |
| `<leader>G`    | Link graph — ASCII outgoing tree + backlinks (sidebar)  |
| `<leader>X`    | Delete the current note (or pick one if not in a note)   |
| `<leader>R`    | Rename / move the current note (offers to rewrite links) |

In the link-graph sidebar: `<CR>` opens the note under the cursor in the previous window, `gv`/`gs` open in vsplit/hsplit, `<Tab>` / `<S-Tab>` deepens / shrinks the tree, `r` re-renders, `q` closes.

## Linking notes

Two link forms work and are followed by `<CR>` / `gf` / `<C-]>`:

- Wiki-style: `[[work/project-x]]` (no `.md` extension needed)
- Markdown:   `[anything](work/project-x.md)` — http(s) and `mailto:` open in the system handler

When you follow a link to a note that doesn't exist yet, the directory is auto-created and the file opens blank.

## Backlinks

`<leader>b` shells out to `ripgrep` to find every note that links to the current one (matches both `[[<basename>]]` and `](<relpath>)`), then opens the results in a Telescope quickfix view.

## Link graph (`<leader>G`)

Opens a sidebar (right-hand vsplit, ~40% wide) rooted at the current note that shows two things:

- **▾ Outgoing tree** — the notes you link to, recursively, with `(N↗ M↙)` annotations on every node showing how many outgoing/incoming links it has. Cycles are marked `(cycle)` and stop recursing; truncated branches end in `…`.
- **◂ Backlinks** — a flat list of every note that links to the current one.

Sidebar keymaps:

| Keys              | Action                                                |
| ----------------- | ----------------------------------------------------- |
| `<CR>`            | Open the note under the cursor in your previous window |
| `gv` / `gs`       | Open in a vertical / horizontal split                 |
| `<Tab>`           | Re-render with `max_depth + 1` (deeper tree)          |
| `<S-Tab>`         | Re-render with `max_depth - 1` (shallower)            |
| `r`               | Re-render at the current depth (catches new links)    |
| `q`               | Close the sidebar                                     |

From any note buffer, `<Tab>` jumps focus back to the graph sidebar when it's open (and falls through to the normal `<C-i>` jumplist when it isn't), so navigating between the graph and notes feels like flipping between two panes.

Also exposed as `:KraNotesGraph [name]` if you want to root the graph at an arbitrary note.

## Renaming and deleting

- `<leader>R` (or `:KraNotesRename [new-rel]`) renames / moves the current note. You're prompted in a centered popup with the existing path pre-filled; type a new relative path (sub-directories are fine, `.md` is optional). Afterwards it asks whether to rewrite incoming `[[wiki]]` and `](path)` references across the whole vault.
- `<leader>X` (or `:KraNotesDelete`) deletes the current note after a `Yes / No` confirmation. From a non-note buffer it opens a Telescope picker so you can choose which note to delete.

Both refuse to touch anything outside `~/.kra/notes/`.
