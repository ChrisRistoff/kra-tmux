# Providers

`kra ai agent` supports two top-level provider backends behind one UX:

| Provider | Backend | Auth | Built-in tools | Extra MCP servers added by Kra |
|---|---|---|---|---|
| `copilot` | `@github/copilot-sdk` | Logged-in Copilot user or `GITHUB_TOKEN` | Yes (SDK tools) | `kra-file-context`, `session-complete`, `kra-memory` |
| `byok` | OpenAI-compatible Chat Completions (`openai`) | Provider API key | No | `kra-file-context`, `session-complete`, `kra-memory`, `kra-bash`, `kra-web` |

## Copilot provider

Wraps `@github/copilot-sdk` behind the provider-neutral session/client path.

- Auth: SDK/device-flow, or token from settings/env
- Models: fetched live at session start; entries can include disabled/billing metadata
- Reasoning effort: optional second picker when model supports it (`low`, `medium`, `high`, `xhigh`)
- Tools: SDK editor tools are excluded so edits route through line-precise file-context tools
- Skills and quota: see [`copilot-operations.md`](./copilot-operations.md)

## BYOK provider

BYOK speaks OpenAI Chat Completions-compatible APIs.

### Supported BYOK sub-providers

| Sub-provider | Base URL | API key source |
|---|---|---|
| `open-ai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `deep-seek` | `https://api.deepseek.com/v1` | `keys.getDeepSeekKey()` |
| `deep-infra` | `https://api.deepinfra.com/v1/openai` | `keys.getDeepInfraKey()` |
| `open-router` | `https://openrouter.ai/api/v1` | `keys.getOpenRouterKey()` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `keys.getGeminiKey()` |
| `mistral` | `https://api.mistral.ai/v1` | `keys.getMistralKey()` |

### BYOK turn mechanics

- One session = one OpenAI client + one MCP client pool
- Streaming loop: model emits text/tool-calls, tool results are fed back as `tool` messages until no more tool calls
- Reasoning deltas are surfaced to the same reasoning panel used by Copilot
- Tool denials are returned as tool results so model can react
- A synthetic turn reminder is injected so housekeeping behavior matches Copilot expectations

### BYOK context-window compaction

BYOK uses summarization compaction when:

1. Provider returns context-length style errors, or
2. Estimated tokens exceed the model context window threshold

Compaction keeps system + recent messages verbatim, summarizes older history, then retries.

### BYOK MCP pool constraints

- BYOK spawns local stdio MCP servers
- Tools are namespaced as `<server>__<tool>`
- Honors per-server allow-lists and excluded tools
- Remote (`http`/`sse`) MCP servers are ignored by BYOK

## Provider backend lifecycle (remove/add)

This is for top-level backends (`copilot`, `byok`, or a future adapter like Claude SDK), not only BYOK sub-provider data.

Shared layers that normally remain unchanged:

- `src/AI/AIAgent/mcp/executableToolBridge.ts`
- `src/AI/AIAgent/mcp/stdioServer.ts`
- `src/AI/shared/conversation/index.ts`

### Remove a provider backend

1. Remove provider selection and startup/session wiring branches
2. Delete adapter implementation under `src/AI/AIAgent/providers/<provider>/`
3. Remove provider-specific auth/model flow
4. Remove provider-specific tests and docs

### Add a provider backend (example: Claude SDK)

1. Add adapter in `src/AI/AIAgent/providers/<new-provider>/`
2. Implement the same session/tool contract used by existing providers
3. Wire provider selection + session bootstrap branches
4. Reuse shared executable-tool bridge + stdio transport
5. Add integration tests for create-session/list-tools/execute-tool/disconnect

If changing only a BYOK sub-provider (`open-ai`, `deep-seek`, etc.), most work stays in `src/AI/shared/data/providers.ts` and `src/AI/shared/data/modelCatalog.ts`.

## Model catalog

Shared live model catalog drives both agent provider/model pickers and chat provider pickers.

- Fetches `/models` from providers at startup
- Uses fallback metadata where providers omit context/pricing
- Caches under `~/.config/kra-tmux/model-catalog/<provider>.json` (24h TTL)
- Falls back to last cache snapshot on network failure
