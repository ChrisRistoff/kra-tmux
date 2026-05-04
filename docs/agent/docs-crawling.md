# Documentation Crawling (`kra memory`)

Crawl public documentation sites, embed the resulting markdown with the same
BGE-Small encoder used for `code_chunks`, and store the chunks in a new
LanceDB table (`doc_chunks`) so the agent can retrieve them via the same
`semantic_search` MCP tool that already serves the codebase index.

## Components

| Piece | Path | Purpose |
|---|---|---|
| `kra memory` → Docs sources tab | `src/AI/AIAgent/commands/memory/dashboard.ts` + `src/AI/AIAgent/commands/memory/sections/docsSources.ts` | Interactive dashboard section: install Crawl4AI, list sources (with per-source actions), crawl all, watch live progress, stop coordinator. |
| Setup helper | `src/AI/AIAgent/commands/docsSetup.ts` | `installCrawl4ai({force})` — programmatic installer for the isolated Python venv, called from the Setup menu entry. |
| Coordinator | `src/AI/AIAgent/shared/docs/coordinator.ts` | Long-lived background process. Single LanceDB writer. Spawned on demand by `IPCClient.ensureServerRunning`. |
| Worker | `automationScripts/python/kra_docs_worker.py` | Python child process per source. Runs Crawl4AI's deep crawl + content filter. Emits JSONL to stdout. |
| Ingest | `src/AI/AIAgent/shared/docs/ingest.ts` | Markdown → chunks → embed → upsert into `doc_chunks`. Re-crawl deletes by `(sourceAlias, url)` first. |

## Install

The Python venv is **not** installed by `npm install`. Run:

```
kra memory        # dashboard → Docs sources tab → "Setup Crawl4AI venv"
```

From the same menu, picking the entry again on an installed venv prompts to
re-install (forces a clean reinstall — ~507 MB).

The setup command:

1. Locates a usable `python3` (≥3.10) on `PATH`.
2. Creates a venv at `~/.kra/crawl4ai-venv/`.
3. Installs the lean dependency set pinned in
   `automationScripts/python/requirements-lean.txt` with `pip install --no-deps -r ...`.
4. Runs `playwright install chromium-headless-shell` (≈189 MB), falling back
   to full chromium if that fails.
5. Touches `~/.kra/crawl4ai-venv/.installed` so subsequent crawls (and the
   coordinator) can verify availability.

## Settings

Configure sources under a new `[ai.docs]` block in `settings.toml`:

```toml
[ai.docs]
enabled = true
maxConcurrentSources = 2
idleTimeoutMs = 30000
cacheRawMarkdown = true

[[ai.docs.sources]]
alias = "lancedb"
url = "https://lancedb.github.io/lancedb/"
maxDepth = 2
maxPages = 200
includePatterns = ["**/lancedb/**"]
excludePatterns = []

[[ai.docs.sources]]
alias = "fastembed"
url = "https://github.com/qdrant/fastembed#readme"
maxDepth = 0
maxPages = 1
```

Types live in `src/types/settingsTypes.ts` (`DocsSource`, `DocsSettings`).
The `enabled` flag is a hard gate: crawl actions in the menu exit early if
it is `false`.

## Commands

| Menu entry | Effect |
|---|---|
| Setup Crawl4AI venv | Install (or re-install with confirmation) the venv at `~/.kra/crawl4ai-venv/`. |
| List configured sources | Browse `[[ai.docs.sources]]` with chunk counts; per-source submenu offers Crawl, Crawl --full, Drop chunks, Show details. |
| Crawl all sources | Queue every configured source on the coordinator (with optional `--full` cache bypass). |
| Live crawl progress | Blessed screen polling `<repo>/.kra-memory/docs-status.json` every 500 ms. `q` closes, `s` sends shutdown. |
| Stop coordinator | Send `shutdown-request` over the IPC socket. |

Crawling is fire-and-forget: the menu spawns the coordinator if needed,
queues the requested sources, then returns. Concurrent invocations from
different shells coalesce — the second invocation just submits more work to
the already-running coordinator.


## IPC and process layout

Single Unix socket at `/tmp/kra-docs.sock` (`IPCsockets.DocsCoordinatorSocket`).

```
kra memory (Docs crawl)  ──emit JSON──▶ /tmp/kra-docs.sock ──▶ coordinator
                                                            │
                                                            ├─ spawn ─▶ python worker (alias=A)
                                                            ├─ spawn ─▶ python worker (alias=B)
                                                            ▼
                                                   ingest.ts → doc_chunks.lance
                                                            ▼
                                                   <repo>/.kra-memory/docs-status.json
```

- **Client → coordinator**: a single JSON-encoded `DocsClientMessage` per
  `IPCClient.emit` call. No reply channel.
- **Worker → coordinator**: JSON Lines on the worker's stdout. Coordinator
  reads via `readline.createInterface({ input: child.stdout })`.
- **Coordinator → CLI status**: a JSON snapshot file refreshed every 2s at
  `<repo>/.kra-memory/docs-status.json`. Read by the live progress screen.

Wire types: `src/AI/AIAgent/shared/docs/types.ts`.

## Single-writer LanceDB

Crawl4AI's worker writes to LanceDB through ingest.ts in this process —
the existing module-level `mutex` in `src/AI/AIAgent/shared/memory/db.ts`
serializes all LanceDB writes (so `code_chunks` and `doc_chunks` cannot
collide if both happen in the same process). Cross-process safety comes from
`LockFiles.DocsWriteInProgress`, refreshed every 30s with a 60s stale
timeout. If the coordinator crashes, the next run reclaims the lock
automatically.

## `doc_chunks` schema

```ts
type DocChunkRow = {
    id: string;            // `${alias}:${hashShort(url)}:${chunkIndex}:${hash.slice(0,12)}`
    sourceAlias: string;
    url: string;
    pageTitle: string;
    sectionPath: string;   // 'Page > H1 > H2' breadcrumb
    chunkIndex: number;
    content: string;       // raw markdown for this section/chunk
    contentForEmbedding: string; // breadcrumb + content, used as embedder input
    contentHash: string;
    tokenCount: number;
    indexedAt: number;     // epoch ms
    vector: number[];      // 384 floats, BGE-Small
};
```

Chunking is **markdown-aware**: the chunker (`shared/docs/chunker.ts`) parses
the page into typed blocks (headings, fenced code, HTML, tables, paragraphs)
and groups them by heading hierarchy. Code blocks, tables, and HTML are kept
atomic — never split mid-block. Each chunk's embedding input is its breadcrumb
(`# Page > H1 > H2`) prepended to the chunk content, which materially improves
semantic match quality on long, deeply-nested pages.

## Incremental updates

Re-running `kra memory` docs crawls is cheap: state is tracked at
`<repo>/.kra-memory/docs-state.json` (per-source, per-URL ETag, Last-Modified,
content hash, lastIndexedAt) and three skip layers fire in order:

1. **Sitemap `<lastmod>`** — if the sitemap reports the page is older than
   our `lastIndexedAt`, the worker emits `page-skipped(reason=sitemap-unchanged)`
   without fetching the page body.
2. **Conditional GET** — `If-None-Match` / `If-Modified-Since` from stored
   ETag/Last-Modified headers. A 304 emits `page-skipped(reason=http-not-modified)`.
3. **Content hash** — after rendering markdown, `sha256(markdown)` is compared
   to the stored `pageHash`. A match emits `page-unchanged` and bumps
   `lastIndexedAt` without rewriting any chunks.

For large sites like AWS CloudFormation (~4 k pages) this typically turns a
15-25 minute full crawl into a 1-2 minute weekly refresh (~10-20× speedup,
~95% bandwidth saved). The state file is per-repo and is intentionally
gitignored — it is a cache, not a source of truth.

### Forcing a full re-crawl

```
kra memory                                            # dashboard
kra memory → Docs sources → Re-index this source       # incremental, single source
kra memory → Docs sources → Re-index this source(full) # bypass all 3 skip layers
The sitemap-first discovery path is used whenever `<base>/sitemap.xml` or
`/sitemap_index.xml` returns 200; otherwise the worker falls back to
`BFSDeepCrawlStrategy` and the second/third layers still apply per fetched
page.


## Known limitations / risks

- Crawl4AI version is pinned. Bumping it requires re-validating the lean
  dependency list — pip will print unmet-pin warnings during install (we
  pass `--no-deps`).
- Anti-bot sites that block the headless-shell are out of scope for v1.
  Detect 403/429 and consider a manual `pip install patchright` follow-up.

## Querying from the agent

The `kra-memory` MCP server exposes a `docs_search(query, k?, sourceAlias?)` tool
backed by `src/AI/AIAgent/shared/docs/search.ts`. It runs hybrid retrieval
on the `doc_chunks` table (vector + full-text fused via RRF — see
[Hybrid retrieval](memory-and-indexing.md#hybrid-retrieval-vector--fts)),
dedupes hits per `(sourceAlias, url)` page, and returns up to 3
best-scoring sections per page with the markdown content inlined (capped
at 1200 characters per section, flagged with `truncated: true` when cut).
Default `k = 8`, hard cap 50.

Use `docs_search` for questions about external library/framework behavior;
use `semantic_search` for repo code. Pass `sourceAlias` to scope to a single
configured source.
