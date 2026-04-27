# Copilot-Only Operations

## Skills

Copilot provider loads skills from `<repo>/skills/` via SDK `skillDirectories`.

- Add a folder under `skills/` to register a skill
- Skills are available on next `kra ai agent` Copilot session
- BYOK has no equivalent skill abstraction

## Quota monitoring

### On-demand

```bash
kra ai quota
```

Shows:

- Monthly usage (live via GitHub API)
- Weekly/session usage (cached from last session headers)

### In-session warnings

Terminal warnings are emitted when remaining weekly/session quota crosses thresholds:

- 50%
- 25%
- 10%

Weekly/session limits come from Copilot response headers and are only refreshed during active sessions.

BYOK does not expose quota telemetry through this flow.
