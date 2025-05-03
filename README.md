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

Can be accessed typing
```
kra tmux
```

and continue with:

• **save-server** entire servers, each server is stores separately so you can work on multiple projects with different setups comfortably. I also use this for different tickets in different scopes, I save the server for current ticket with all the files I work on opened, if ticket comes back from testing or I need to do something else on it, it's there for me to bring back just how I left it.

• **load-server** your server just how you left it off, all the sessions, all the windows, all the panes and their sizes and all neovim sessions just how you left them off. If a server was saved inside a git repo and it is not available when you load, the app will try to clone the repo you were in and navigate to the folder.

• **delete-session** your servers individually. An overview of the server with sessions, number of windows and their names will be shown once you select it so you can decide whether you want to delete it or not.

• **list-sessions** your current server with number of windows etc.

• **kill** your currently running server.

---

## Git Integration

The Git integration in this tool is designed to facilitate efficient source control management.

Access with:
```bash
kra tmux
```

• **restore** Recover single or multiple files effortlessly.

• **cache-untracked** Save untracked files in a separate project folder, they get saved under the branch name and can only be retrieved inside the same branch.

• **retrieve-untracked:** Retrieve your cached untracked files when needed.

• **hard-reset** Fetch with pruning and perform a hard reset to keep your branch in sync.

• **log** Generate a beautifully formatted Git log that's navigable in neovim using '{' and '}' keys.

• **stash** Apply or drop stashes with an intuitive selection menu.

• **stash-drop-multiple** Drop multiple stashes by selecting from a dynamic list.

• **conflict-handle** Access a list of conflicted files and resolve them using a three-way split in neovim, with continuous scans until all conflicts are addressed.

• **view-changed** Quickly see what’s changed and open files to inspect modifications.

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
