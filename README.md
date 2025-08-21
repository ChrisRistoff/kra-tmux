# Kra Workflow

A **zero-overhead development environment** built around a custom IPC-based autosave engine. Designed for developers who need bulletproof workspace persistence without sacrificing performance.

**Core Philosophy**: Your work should never be lost, your tools should stay out of your way, and your development flow should be seamless across tmux, neovim, shell, and Git operations. No background processes unless actually needed.

**Interface Design**: All menus and selection lists feature **live filtering** — type to instantly narrow down options, making every operation fast and keyboard-driven.

![Workflow](docs-assets/kra-workflow-png.png)

---

## 🏗️ Architecture Overview

### The Autosave Engine
*Custom IPC system that eliminates data loss without overhead*

At Kra's core is a **event-driven persistence engine** built on Unix domain sockets. Unlike traditional autosave systems that poll or run background processes, Kra's architecture responds only to actual meaningful workspace changes:

```
Event Sources (tmux hooks, shell chpwd, neovim autocmds)
    ↓
AutoSave Manager (validates & coordinates)
    ↓
IPC Client/Server (Unix socket communication)
    ↓
Debounced Save Process (atomic workspace persistence)
```

**What makes it different:**
- **Event-driven only** — No polling, no constant background processes, no timed intervals that miss your work
- **Nanosecond IPC communication** — Ultra-fast Unix socket protocol with sub-100ms complete save cycles
- **Atomic operations** — Race condition prevention with graceful shutdown handling
- **Cross-environment sync** — Tmux sessions, Neovim states, shell contexts unified

The system tracks workspace changes through native editor and shell hooks, debounces them intelligently, and persists complete development states atomically. You get continuous backup without the overhead.

> 🔗 **[Technical Deep Dive: Autosave Architecture →](AUTOSAVE.md)**

**Persists everything automatically:**
- Complete tmux server states (sessions, windows, panes, layouts)
- Neovim editing contexts (buffers, cursors, session data)
- Shell environments (directories, history, variables)
- Git repository states and working tree status
- AI conversation threads with searchable summaries

---

## 🛠️ Development Tools

All Kra modules integrate with the autosave engine — your work is continuously preserved across every operation.

### 📺 Tmux Integration
*Session lifecycle management with persistent workspace state*

![tmux](docs-assets/tmux/tmux.png)

Complete tmux server management with automatic workspace restoration. Sessions, windows, pane layouts, and active processes are preserved and restored exactly as you left them.

> 📦 **`kra tmux`**

| Command | Purpose |
|---------|---------|
| **save-server** | Manual save trigger (autosave runs continuously) |
| **load-server** | Restore exact workspace state with repo auto-cloning |
| **delete-server** | Clean up saved servers with preview |
| **list-sessions** | Real-time server session overview |
| **kill** | Graceful termination with final autosave |

<details>
<summary>💾 save-server demo</summary>

Manual save trigger (autosave runs continuously in background via IPC). Captures complete tmux server state including all sessions, windows with names, pane layouts, and active Neovim sessions.

![Save](docs-assets/tmux/tmux-save-server.gif)
</details>

<details>
<summary>♻️ load-server demo</summary>

Select from autosaved servers. Automatically restores build/watch commands, directory states, and active processes exactly as you left them.

![Load](docs-assets/tmux/tmux-load.gif)
</details>

<details>
<summary>🧹 delete-server demo</summary>

Safe deletion with preview. Shows complete session hierarchy before confirmation — sessions, window count, pane count.

![Delete](docs-assets/tmux/tmux-delete-server.gif)
</details>

---

### 🌿 Git Operations
*Advanced source control with intelligent conflict resolution*

![git](docs-assets/git/git.png)

Professional Git workflows designed for complex branching strategies and team development. All Git operations coordinate with autosave for repository state preservation.

> 📦 **`kra git`**

| Command | Purpose |
|---------|---------|
| **restore** | Smart file recovery with preview |
| **cache-untracked** | Branch-specific untracked file storage |
| **retrieve-untracked** | Conflict-aware cached file restoration |
| **hard-reset** | Clean sync with detailed status reporting |
| **log** | Navigable Git history in Neovim |
| **stash** | Interactive stash management |
| **stash-drop-multiple** | Batch stash cleanup |
| **conflict-handle** | 3-way diff conflict resolution |
| **open-pr** | Instant PR access (GitHub/Bitbucket) |
| **view-changed** | Live diff inspection |
| **create-branch** | Clean branch creation workflow |
| **checkout** | Smart branch filtering with stash handling |

<details>
<summary>♻️ restore demo</summary>

Interactive file restore with live filtering. Select individual files or "all" option for batch operations.

![Restore](docs-assets/git/git-restore.gif)
</details>

<details>
<summary>⚔️ conflict-handle demo</summary>

Enterprise-grade conflict resolution. 3-way Neovim diff with intelligent conflict marker detection and automatic list updates.

![conflict handle](docs-assets/git/git-conflict-handle.gif)
</details>

<details>
<summary>🌿 create-branch demo</summary>

Professional branch creation workflow. Base branch selection, remote sync, clean state verification, new branch creation and checkout to new branch.

![create-branch](docs-assets/git/git-create-branch.gif)
</details>

---

### 🤖 AI Assistant
*Persistent conversations with intelligent chat management*

![AI Chat Bot Demo](docs-assets/chat/ai-chat-bot.png)

Socket-based AI integration with automatic conversation persistence. All chats are preserved with AI-generated summaries for searchability.

> 📦 **`kra ai`**

| Command | Purpose |
|---------|---------|
| **chat** | Socket-based chat in Neovim with auto-save on close |
| **load** | Searchable conversation browser with preview |
| **delete** | Safe chat deletion with confirmation |

<details>
<summary>🗨️ chat demo</summary>

Professional AI chat setup with role/provider/temperature configuration. Socket-based input system allows precise control over context and responses. Auto-save integration preserves all conversations.

![new chat](docs-assets/chat/ai-new-chat.gif)
</details>

<details>
<summary>💾 Auto-save integration</summary>

Automatic conversation persistence. On chat close, AI-generated summaries created for searchability. All conversations indexed by autosave system.

![save chat](docs-assets/chat/ai-save-chat.gif)
</details>

---

### 🛠️ System Utilities
*Workspace management with autosave coordination*

![System Utils](docs-assets/sys/system.png)

Essential development utilities that coordinate with the autosave system for workspace integrity.

> 📦 **`kra sys`**

| Command | Purpose |
|---------|---------|
| **grep-file-remove** | Smart file deletion with workspace state awareness |
| **grep-dir-remove** | Directory cleanup with preservation coordination |
| **scripts** | Custom automation framework (experimental) |

---

## 🚀 Key Benefits

**Performance**: Event-driven architecture eliminates background overhead while maintaining sub-100ms response times.

**Reliability**: Atomic operations with race condition prevention ensure your work is never lost, even during system crashes.

**Integration**: All tools share the same autosave foundation — tmux sessions, editor states, Git repos, and AI conversations unified.

**Professional**: Designed for complex development workflows with enterprise-grade error handling and graceful degradation.

**Extensible**: Plugin architecture allows custom integrations while maintaining the core autosave guarantees.

---

## 🛠️ Getting Started

Refer to the [Installation Guide](INSTALLATION.md) for complete setup instructions and configuration options.

---

**For developers who demand zero data loss, maximum performance, and seamless tool integration.**
