# Tools and MCP

## File editing tools (`kra-file-context`)

`kra-file-context` is the line-precise editing surface. Copilot stock editor tools are excluded so edits go through deterministic range operations.

```txt
excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob']
```

### Core file-context tools

| Tool | Purpose |
|---|---|
| `search(name_pattern?, content_pattern?)` | Unified file finder + grep (glob/regex or both) |
| `get_outline(file_path)` | Structural outline (symbols + line numbers) |
| `read_lines(...)` | Read exact line ranges (single or array form) |
| `read_function(file_path, function_name)` | Return full function/class body by name |
| `edit_lines(...)` | Replace exact ranges (single or array form) |
| `create_file(file_path, content)` | Create new file |
| `lsp_query(...)` | Hover/definition/references/etc via language server |

### `search` options

- `name_pattern` (glob)
- `content_pattern` (ripgrep regex)
- `path`, `type`, `case_insensitive`, `context`, `multiline`, `max_results`

At least one of `name_pattern` or `content_pattern` is required.

### `read_lines` gating

- Hard cap: 500 lines/call
- Soft gate: requests over 200 lines on structured files are bounced to `get_outline` first

### Recommended workflow

1. `search`
2. `get_outline`
3. `read_lines`
4. `edit_lines`

Prefer array-form reads/edits for multiple disjoint ranges.

## BYOK-only extra tools

Because BYOK has no SDK tools, Kra injects these MCP servers for BYOK sessions:

### `kra-bash` (`bash`)

- Executes command in session working dir
- 120s timeout, 10MB stdout/stderr cap
- Long output is head/tail truncated
- Emits git status before/after for history tracking

### `kra-web` (`web_fetch`, `web_search`)

| Tool | Purpose | Limits |
|---|---|---|
| `web_fetch(url, max_length?)` | Fetch + text extraction | default 8k chars, cap 50k, 20s timeout |
| `web_search(query, max_results?)` | DuckDuckGo HTML search summary | default 5 results, cap 15 |

Copilot does not load `kra-bash`/`kra-web` (SDK already has equivalents).

## MCP server configuration (`settings.toml`)

```toml
[ai.agent.mcpServers.filesystem]
active = true
type = "local"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
tools = ["*"]

[ai.agent.mcpServers.github]
active = true
type = "http"
url = "https://api.githubcopilot.com/mcp/"
tools = ["*"]
```

Only servers with `active = true` are injected.

Provider behavior differences:

- Copilot: supports local + remote MCP servers
- BYOK: local stdio servers only (`http`/`sse` ignored)
