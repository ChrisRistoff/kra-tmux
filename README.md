# Kra workflow

Welcome to the Kra Worflow! This project brings together a suite of integrations designed to supercharge user's development workflow. With powerful features built around tmux server management, Git operations, and an AI chatbot, you get a comprehensive tool that streamlines your workflow.

Explore the features below and click the links to jump to detailed sections:

• [Tmux Integration](#tmux-integration)
• [Git Integration](#git-integration)
• [AI Chatbot Integration](#ai-chatbot-integration)
• [Getting started](#getting-started)

---

## Tmux Integration

My tmux integration module is engineered to give you full control over your server sessions.

Access with.
```
kra tmux
```

### Avaiable commands:
| Command            | Description                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **save-server**    | 💾 Save entire servers — including all sessions, windows, panes, and Neovim states. Perfect for multitasking across different projects or tickets. |
| **load-server**    | ♻️ Reload your saved server *exactly* how you left it — including repos (auto-clones if missing), directories, layouts, and editor states.         |
| **delete-session** | 🧹 Clean up specific saved servers. Preview the structure (sessions, windows, names) before confirming deletion.                                   |
| **list-sessions**  | 📋 View a summary of the current server's sessions and windows.                                                                                    |
| **kill**           | ❌ Terminate the currently running server instantly.                                                                                                |
---

## Git Integration

The Git integration in this tool is designed to facilitate efficient source control management.

Access with:
```
kra tmux
```
| Command                 | Description                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **restore**             | ♻️ Recover single or multiple files effortlessly.                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **cache-untracked**     | 📦 Save untracked files in a branch-specific cache. Files are stored per branch and retrievable only within the same branch. |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **retrieve-untracked**  | 🔄 Retrieve your previously cached untracked files.                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **hard-reset**          | 🧹 Perform a `git fetch --prune` and hard reset to keep your local branch clean and in sync.                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **log**                 | 📜 View a rich, navigable Git log inside Neovim. Use `{` and `}` keys to jump between commits.                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **stash**               | 💼 Apply or drop stashes using an intuitive selection interface.                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **stash-drop-multiple** | 🗑️ Select and drop multiple stashes in one go from a dynamic list.                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **conflict-handle**     | ⚔️ Easily resolve merge conflicts in Neovim with a three-way split and auto-scan until all are resolved.                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **view-changed**        | 🔍 Instantly see file changes and open them for inspection.                                                                  |
---

## AI Chatbot Integration

User can chat with any model, chat is opened up in neovim, pressing enter in normal mode will send the entire chat as prompt, user and AI messages are formatted in markdown.
**Save** your chats along with a summary. summary will be generated for them and opened in neovim where they can edit it if they so choose. Once the summary is closed the save will be created.

Can be accessed typing
```
kra tmux
```

and continue with:

• **chat**: Will start a new chat inside neovim, it's using sockets to listen to user pressing enter in normal mode, once enter is sent entire chat is sent as a prompt. Once the user closes the file they will be asked if they want to save the chat, if yes summary will be generated for them and opened in neovim where they can edit it if they so choose. Once the summary is closed the save will be created.

• **load**: User will be presented with a list of all saved chats, once they choose one the summary of said chat will be opened in neovim, once the user closes that they can choose whether they still want to load the chat or not, if they do chat will be opened in neovim, if not they will be presented with the list of chats to pick a new one.

• **delete**: User will be presented with a list of saved chats, they can pick one and delete it.

---

## Getting Started

To get started, please refer to the [Installation Guide](docs/installation.md) which covers the prerequisites, setup instructions, and initial configuration. Once you're set up, dive into each integration module with the links provided above.
