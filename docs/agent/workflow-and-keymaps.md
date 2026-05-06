# Workflow and Keymaps

## Turn lifecycle (high-level)

1. Start with `kra ai agent`
2. Pick provider/model
3. Submit prompt from Neovim chat buffer
4. Agent streams text/reasoning, requests tools when needed
5. Tool approval UI mediates tool calls (unless YOLO)
6. Successful writes become session diffs for review/apply/reject

## Chat buffer keymaps

| Key | Action |
|---|---|
| `Enter` | Submit prompt |
| `Ctrl+C` | Stop current turn |
| `@` | Add file contexts |
| `r` / `f` / `Ctrl+X` | Remove/show/clear file contexts |
| `<leader>o` / `<leader>a` / `<leader>r` | Open/apply/reject proposal |
| `<leader>y` / `<leader>P` | Toggle YOLO / reset remembered approvals |
| `<leader>h` | Tool call history |
| `<leader>s` | Session diff history |
| `<leader>m` | Memory browser/editor |
| `<Space>t` | Toggle tool/intent popups |
| `<leader>?` | Show all keymaps (which-key) |

## Tool call history (`<leader>h`)

Opens searchable history of all tool calls in this session.

- Preview shows tool result for selected call
- `<CR>` opens side-by-side view: args JSON vs result
- Read-only inspection surface (not a rerun UI)

## Proposal review tab keymaps

| Key | Action |
|---|---|
| `a` | Apply proposal |
| `r` | Reject proposal |
| `o` | Open changed file |
| `R` | Refresh diff |
| `q` | Close tab |

## Tool approval behavior

Auto-approved tools:

- `ask_kra`

All other tools require approval in strict mode.

### Approval popup keys

| Key | Action |
|---|---|
| `<CR>` | Run highlighted action |
| `<Up>` / `<Down>` | Move highlight |
| `a` | Approve once |
| `s` | Allow tool family for session |
| `y` | Enable YOLO mode |
| `e` | Open diff editor (writes) |
| `J` / `<leader>j` | Open raw tool args JSON |
| `d` / `q` | Deny call |

## Diff editor and user edits

From approval popup on write tools, `e` opens a three-pane diff view: current / proposed / reference. For non-write tools, args inspection/editing stays in the JSON args editor path.

| Key | Action |
|---|---|
| `<leader>a` | Approve (including user-edited proposal) |
| `<leader>d` | Deny |
| `<leader>j` | Edit tool args JSON |
| `q` | Close and deny |

When user edits proposed content before approval, Kra rebuilds the tool mutation as concrete `edit` arguments and optionally notifies the model with post-edit context.

## Session diff history (`<leader>s`)

Tracks successful write effects for the current session.

- One entry per successful write
- One `ORIG` entry per file (pre-session baseline vs current)
- Supports per-file revert to pre-session state
- Denied/failed/intercepted writes are not committed to history
