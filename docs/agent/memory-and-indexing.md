# Persistent Memory and Indexing (`kra-memory`)

`kra-memory` is a local vector memory layer used by the agent to persist findings and revisits across sessions.

It is auto-loaded for both providers together with `kra-file-context` and `kra-session-complete`.

## Storage layout

- `<repo>/.kra-memory/lance/memory_findings.lance/`
- `<repo>/.kra-memory/lance/memory_revisits.lance/`

Findings store: `note | bug-fix | gotcha | decision | investigation`

Revisits store: deferred items with status (`open | resolved | dismissed`)

## Embeddings

- `fastembed` + BGE-small int8
- Offline, no external model/API required

## Memory picker/editor (`<leader>m`)

Within agent chat buffer:

- Browse all/findings/revisits
- Add/edit/delete entries
- Resolve/dismiss revisits
- Open and edit entries in markdown scratch buffer

Agent memory reads (`recall` / memory-scoped `semantic_search`) are approval-intercepted, and only selected IDs are returned.

CLI alternative for cross-repo memory management: `kra memory`.

## Exposed MCP tools

| Tool | Purpose |
|---|---|
| `remember` | Create findings/revisit entries |
| `recall` | Query/list memories (kind required) |
| `update_memory` | Resolve/dismiss revisits |
| `semantic_search` | Conceptual search across code and/or memory |
| `edit_memory` | Update title/body/tags/paths |

## Agent memory conventions

- Write `bug-fix`/`gotcha`/`decision` when learnings are reusable
- Use `revisit` for deferred ideas
- Close revisits via `update_memory` instead of duplicating entries

## Settings

```toml
[ai.agent.memory]
enabled = true
indexCodeOnSave = false
autoSurfaceOnStart = false
gitignoreMemory = true
# chunkLines = 80
# chunkOverlap = 5
```

## Code indexing model

Code semantic search is opt-in per launch and tracked in a central registry:

- Registry: `~/.kra-memory/registry.json`
- Identity: repo remote URL (path fallback for non-git)
- First index: full reindex
- Subsequent index: catch-up (committed + uncommitted changes)

Additional indexing flows:

1. `kra ai index` (manual full reindex)
2. `indexCodeOnSave = true` (background watcher)

Index implementation highlights:

- File discovery via `git ls-files -co --exclude-standard`
- Chunking by fixed line windows + overlap
- Content-hash chunk IDs to avoid re-embedding unchanged chunks
- Stored in `<repo>/.kra-memory/lance/code_chunks.lance/`
