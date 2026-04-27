# Agent Mode Docs

This folder contains the technical docs for `kra ai agent`. `AGENT.md` at the repo root is now the quick overview; use these sub-docs for implementation-level detail.

## Start here

```bash
kra ai agent
```

1. Pick provider (`copilot` or `byok`)
2. Pick model (and reasoning effort for supported Copilot models)
3. Work in Neovim chat buffer, review diffs, approve/reject tool calls

## Doc map

| Doc | What it covers |
|---|---|
| [`providers.md`](./providers.md) | Provider architecture, Copilot/BYOK behavior, backend add/remove lifecycle, model catalog |
| [`workflow-and-keymaps.md`](./workflow-and-keymaps.md) | Turn lifecycle, keymaps, tool approval UX, diff editor behavior, session diff history |
| [`tools-and-mcp.md`](./tools-and-mcp.md) | File-context tools, bash/web tools, MCP configuration and provider differences |
| [`memory-and-indexing.md`](./memory-and-indexing.md) | `kra-memory` store, tools, picker UX, indexing behavior and settings |
| [`copilot-operations.md`](./copilot-operations.md) | Copilot-only skills and quota monitoring |

## Contributor orientation

If you are modifying the agent stack, these are the highest-signal implementation areas:

- Provider adapters: `src/AI/AIAgent/providers/*`
- Shared provider abstractions: `src/AI/AIAgent/mcp/executableToolBridge.ts`, `src/AI/AIAgent/mcp/stdioServer.ts`
- Shared conversation boundary: `src/AI/shared/conversation/index.ts`
- Prompt/action orchestration: `src/AI/AIAgent/shared/main/*`
