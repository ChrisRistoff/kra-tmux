# Tools and MCP

## File editing tools (`kra-file-context`)

`kra-file-context` is the line-precise editing surface. Copilot stock editor tools are excluded so edits go through deterministic range operations.

```txt
excludedTools: ['str_replace_editor', 'write_file', 'read_file', 'edit', 'view', 'grep', 'glob', 'apply_patch', 'report_intent']
```

### Core file-context tools

| Tool | Purpose |
|---|---|
| `search(name_pattern?, content_pattern?)` | Unified file finder + grep (glob/regex or both) |
| `get_outline(file_path)` | Structural outline (symbols + line numbers) |
| `read_lines(...)` | Read exact line ranges (single or array form) |
| `read_function(file_path, function_name)` | Return full function/class body by name |
| `anchor_edit(file_path, edits[])` | Anchor-based edits (replace / insert / delete), each edit's anchor must match the file exactly once. Multiple edits per call. Renamed from `edit` so the orchestrator's exclusion of Copilot's built-in `edit` tool no longer collides with the MCP tool. |
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
4. `anchor_edit`

Prefer array-form reads/edits for multiple disjoint ranges.

## BYOK-only extra tools

Because BYOK has no SDK tools, Kra injects these MCP servers for BYOK sessions:

### `kra-bash` (`bash`)

- Executes command in session working dir
- 120s timeout, 10MB stdout/stderr cap
- Long output is head/tail truncated (caps configurable per profile in `[ai.agent.truncation]` / `[ai.agent.subAgentTruncation]`)
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

## Sub-agent tools

Opt-in helpers that let a smaller, cheaper model do bulk work while the
orchestrator focuses on reasoning. Toggle in `settings.toml`
(`[ai.agent.executor]`, `[ai.agent.investigator]`, `[ai.agent.investigatorWeb]`);
when enabled, the start flow prompts for a separate provider + model right after
the orchestrator picker. Sub-agents work for both BYOK and Copilot
orchestrators — mix and match freely.

### `investigate` (investigator sub-agent)

Registered on the orchestrator only when `[ai.agent.investigator].code = true`.
Delegates a research question to a smaller model that returns a curated,
evidence-backed synthesis instead of raw file dumps.

| Field | Purpose |
|---|---|
| `query` | The research question. May bundle tightly-related sub-questions sharing the same scope. |
| `hint` | Anything that would shortcut the investigator's work — known paths, symbol names, prior findings, user context, suspected cause. |
| `scope` | Optional path glob (e.g. `src/AI/**`). |
| `kind` | Optional category hint: `find_implementation` / `find_usages` / `find_pattern` / `explain_flow` / `general`. |

Returns:

```json
{
  "summary": "…",
  "evidence": [{ "path": "…", "lines": "12-40", "excerpt": "…", "why_relevant": "…" }],
  "confidence": "high|medium|low",
  "suggested_next": "…"
}
```

Behavior notes:

- The orchestrator may call `investigate` at any point in a turn — not just at the start.
- Only one investigation runs at a time; concurrent calls are rejected until the active one finishes.
- Investigator tool whitelist (default): `semantic_search`, `search`, `get_outline`, `read_lines`, `lsp_query`, `docs_search`, `recall`.
- When `validateExcerpts = true` (default) every excerpt is checked against the file at the stated line range before being returned to the orchestrator; hallucinated snippets are stripped.
- `maxEvidenceItems` and `maxExcerptLines` cap the size of the returned envelope to keep the orchestrator's context cheap.
- Investigator output streams into the same chat file under a sub-agent header (rendered as a markdown blockquote).

When the orchestrator should call it:

- Any open-ended question that needs reading more than ~2 files or tracing a flow across modules.
- After a partial result reveals more research is needed (call again, pass new findings via `hint`).

When the orchestrator should skip it:

- Trivial lookups where the exact file + line range is already known.
- Cases where it must edit immediately based on context the user just gave.

### `execute` (executor sub-agent)

Registered on the orchestrator only when `[ai.agent.executor].enabled = true`.
Delegates a concrete, multi-step body of work to a smaller model that runs the
plan end-to-end and returns a curated event log + summary; the raw tool traffic
(file reads, search results, intermediate edits) never enters the orchestrator's
context.

| Field | Purpose |
|---|---|
| `plan` | Step-by-step plan to execute. Be explicit about what to change and where. |
| `context` | Optional background the executor should treat as authoritative — prior findings, paths, user constraints. Generous context here saves tool calls on the executor side. |
| `successCriteria` | Optional checklist the executor uses to decide between `completed` and `partial`. |

Returns a structured envelope with `status` (`completed` / `partial` /
`blocked` / `needs_replan`), a 2–6 sentence `summary`, a typed `events[]` array
(with optional `path` and inline `diff` per event), and `blockers[]` /
`replanReason` when relevant.

Behavior notes:

- Runtime sharing: when `useInvestigatorRuntime = true` (default) and the
  investigator is also enabled, the executor reuses the investigator's
  resolved provider + model. Set it to `false` to be prompted for a separate
  executor model on startup.
- Only one execution runs at a time; concurrent calls are rejected.
- `Ctrl-C` (`stop_stream`) aborts the executor and returns control to the
  orchestrator. The orchestrator sees the partial event log captured so far.
- Executor tool whitelist (default): `read_lines`, `get_outline`, `anchor_edit`,
  `create_file`, `search`, `lsp_query`, `bash`. `ask_kra` and
  other end-of-turn tools are forbidden — the orchestrator owns the turn.
- Hard cap of `maxToolCalls` (default 60) tool calls before the executor is
  expected to submit — prevents runaway loops on bad plans.
- Executor output streams into the same chat file under a sub-agent header
  (⚙️ `[EXECUTOR]`).
- As soon as the executor calls `submit_result`, control returns to the
  orchestrator immediately — it does not wait for the model to wind down its
  trailing acknowledgement.

When the orchestrator should call it:

- Multi-step refactors, feature implementations, or any task whose bulk is
  mechanical reads + edits rather than reasoning.
- After `investigate` has produced enough findings to write a concrete plan.

When the orchestrator should skip it:

- One-line trivial edits.
- Tasks that need orchestrator-grade reasoning at every step.

### `investigate_web` (web research sub-agent)

Registered on the orchestrator only when `[ai.agent.investigator].web = true`.
The `code` and `web` switches are independent; if both are on, the web
investigator piggy-backs on the code investigator's runtime by default
(`useInvestigatorRuntime = true` under `[ai.agent.investigatorWeb]`). Delegates a research
question whose answer lives **outside** this repo (library/SDK behaviour, vendor
docs, RFCs, current ecosystem state) to a sub-agent that searches, scrapes, and
returns curated `{summary, evidence, confidence}` excerpts.

| Field | Purpose |
|---|---|
| `questions` | Array of related sub-questions for this investigation. **One call per scope** — if multiple questions share the same library, vendor, or docs source, list them ALL in this array so the sub-agent answers them from one round of fetches. Split into separate calls only when topics are genuinely unrelated. |
| `hint` | Optional steering shared by all questions: known canonical URLs, version, prior findings, user context. |

Returns:

```json
{
  "summary": "…",
  "evidence": [
    { "url": "https://…", "title": "…", "section": "…", "excerpt": "…", "why_relevant": "…" }
  ],
  "confidence": "high|medium|low",
  "suggested_next": "…",
  "partial": false,
  "pages_fetched": 4,
  "pages_failed": 0,
  "chunks_indexed": 37,
  "searches": 2,
  "scrapes": 1
}
```

Sub-agent toolset (4 tools):

- `web_search(query, max_results?)` — pure search; returns `[{title, url, snippet}]`.
  Quota: `maxSearches`.
- `web_scrape_and_index({urls, queries, k?})` — fetches the URLs in parallel,
  chunks them with the markdown chunker, embeds with the local BGE model,
  inserts rows into a per-investigation LanceDB table, then runs vector search
  per query and returns merged hits. Quota: `maxScrapes`; URLs capped at
  `urlsPerScrape`.
- `research_query({query, k?})` — vector search over the chunks already
  indexed during this investigation (no new fetching). For drilling into pages
  the agent already scraped.
- `submit_result(…)` — finalize.

Behavior notes:

- Runtime sharing: when `useInvestigatorRuntime = true` (default) and the
  investigator is enabled, the web investigator reuses the code investigator's
  resolved provider + model. Set it to `false` to be prompted for a separate
  model on startup.
- The orchestrator never sees raw page bodies — only retrieved excerpts. URL
  filtering is coarse (titles / snippets); fine relevance is vector retrieval.
- Each call mints a fresh `researchId` (UUID); chunks are tagged with it so
  concurrent investigations never cross-contaminate.
- TTL eviction (default 60 min, `ttlMinutes`) plus `SIGINT`/`SIGTERM`/`exit`
  cleanup hooks ensure the LanceDB table doesn't grow unbounded.
- When `validateExcerpts = true` (default) every excerpt is checked against the
  indexed chunks before being returned; unverified snippets are flagged in
  `why_relevant`.
- Only one `investigate_web` runs at a time; concurrent calls are rejected.
- `maxEvidenceItems`, `maxExcerptLines`, and `maxToolCalls` cap the size of
  the returned envelope and the sub-agent loop.
- Sub-agent output streams into the chat file under a 🌐 `[INVESTIGATOR-WEB]`
  header.

When the orchestrator should call it:

- Library / SDK behaviour the user is asking about that isn't documented in
  this repo's `docs_search` corpus.
- Vendor / RFC / standards questions where authoritative pages live online.
- Current ecosystem state (API changes, deprecations, recent releases).

When the orchestrator should skip it:

- Anything answerable from this repo's code or its indexed `docs_search`
  corpus — use `investigate` instead.
- Single-fact lookups where one `web_fetch` would do.

