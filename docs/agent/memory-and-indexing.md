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

## Multi-repo search (active repo group)

`semantic_search` (code scope) can fan out across multiple indexed repos in
a single session, not just the current one.

- Active set lives in `~/.kra-memory/groups.json` (`active: ["<repoKey>", …]`).
- Selected via `kra memory → Indexed repos`: `space` toggles a repo, `a`
  saves the selection as the active group. Selection state is rendered
  next to each row.
- The MCP launcher injects the resolved keys as
  `KRA_SEARCH_REPO_KEYS=key1,key2,…` into the memory server.
- `searchCode` resolves the active set, opens each repo's `code_chunks`
  table (cached per `repoKey`), runs hybrid retrieval per repo in
  parallel, then groups results by `<repoKey>::<path>`.
- Cross-repo hits are emitted with the repo's alias and an absolute
  `path` so `read_lines` works regardless of which repo is on disk.
- Falls back to single-repo mode when the active set is empty (current
  repo only, relative paths — unchanged from before).

Findings/revisits remain per-repo — only the code index is shared across
the active group.

## Hybrid retrieval (vector + FTS)

Both code and docs search use Reciprocal Rank Fusion to combine semantic
(vector) and lexical (full-text) rankings:

1. Run vector search and FTS in parallel (`fetchK` candidates each).
2. Fuse with RRF (`k = 60`); normalize scores to `[0, 1]` so they remain
   comparable to the cosine scores returned by memory search when
   `scope = 'both'`.
3. Vector-only candidates below `MIN_SCORE` are dropped; any hit that
   surfaced via FTS survives regardless (a keyword match is its own
   evidence).
4. When FTS returns nothing (index missing, query parser rejected the
   text, or no lexical matches), fall back to pure cosine scoring so
   score magnitudes are preserved.

The FTS index on `content` is created lazily on the first table open
after the upgrade for both `code_chunks` and `doc_chunks`. Errors are
swallowed — search transparently falls back to vector-only when the
index is unavailable.

Free-form queries are sanitized (operator characters stripped) before
being handed to the LanceDB FTS parser, so code-y queries can't crash
the parser.

Shared implementation: `src/AI/AIAgent/shared/memory/hybridSearch.ts`.
