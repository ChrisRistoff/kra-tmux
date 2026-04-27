# Installation

## 📦 Prerequisites

Make sure you have the following installed:

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/)
- [Git](https://git-scm.com/)
- [Neovim](https://neovim.io/)
- [Tmux](https://github.com/tmux/tmux/wiki/Installing)
- [render-markdown.nvim](https://github.com/MeanderingProgrammer/render-markdown.nvim)

## 🚀 Install

### From npm (recommended)

```bash
npm install -g kra-workflow
```

> **Avoid `sudo`.** If your global npm prefix isn't writable (default on
> Homebrew/Linux), either use a Node version manager like
> [nvm](https://github.com/nvm-sh/nvm) / [fnm](https://github.com/Schniz/fnm),
> or point npm at a user dir: `npm config set prefix ~/.npm-global` and add
> `~/.npm-global/bin` to your `PATH`. Then `npm install -g kra-workflow` runs
> entirely under your home directory — no root, no surprises.

The `npm install` runs a postinstall step that does the heavy lifting:

1. Creates `~/.kra/` with the standard layout (`settings.toml`, `git-files/`,
   `tmux-files/`, `ai-files/`, `system-files/`, `lock-files/`, `model-catalog/`,
   `cache/`).
2. Copies a default `settings.toml` from the package template if one isn't already present.
3. Appends `source <package>/automationScripts/source-all.sh` to your `~/.bashrc`
   and `~/.zshrc` (idempotent).
4. Installs `neovimHooks.lua` into `~/.config/nvim/lua/` and adds
   `require("neovimHooks")` to `~/.config/nvim/init.lua` (idempotent).
5. If `~/programming/kra-tmux/` exists and `~/.kra/` is being created for the
   first time, copies your existing data into `~/.kra/`. Originals are NOT
   removed.
6. Touches `~/.kra/.installed` so future installs/runs skip the heavy work.

Restart your shell (or `source ~/.bashrc` / `source ~/.zshrc`) afterwards so
the shell autocompletion and tmux/neovim hooks become active. Then run `kra`.

> **Note on `sudo npm install -g`** — when run as root the installer detects
> `SUDO_USER` and resolves the invoking user's real home directory, so dotfiles
> still land in the right place.
>
> **Note on `npm install --ignore-scripts`** — if you skip postinstall, the
> first invocation of any `kra` command will detect the missing `~/.kra/.installed`
> marker and run setup automatically. You can also re-trigger it manually by
> reinstalling the package or running `node $(npm root -g)/kra-workflow/bin/postinstall.js`.

### From source

```bash
git clone https://github.com/ChrisRistoff/kra-tmux.git
cd kra-tmux
npm install
npm run build       # compiles TypeScript into dest/
npm install -g .    # link the local build globally as `kra`
kra                 # triggers first-run setup
```

## 🗂️ Filesystem layout

User data (override the root with `KRA_HOME=/some/dir`):

```
~/.kra/
├── settings.toml          # main config
├── git-files/             # untracked-files store for git workflow
├── tmux-files/            # tmux + neovim session snapshots
├── ai-files/              # chat history + lua helpers
├── system-files/          # custom scripts
├── lock-files/            # autosave coordination
├── model-catalog/         # cached model lists per AI provider
├── cache/fastembed/       # embedding model cache
├── quota-cache.json       # AI agent quota snapshots
└── .installed             # first-run marker
```

Per-repo memory (independent of `~/.kra`): each repo using the AI agent gets a
`<repo>/.kra-memory/` LanceDB store, registered globally in
`~/.kra-memory/registry.json`.

## 🛠️ Commands

- `kra` — show the main menu.

Setup is fully automatic — it runs via npm `postinstall`, with a fallback on
the first `kra` invocation if the postinstall step was skipped.

## 🧪 Troubleshooting

- **Autocompletion not working** — re-source your shell rc or open a new shell.
- **Hook didn't load in nvim** — check that `~/.config/nvim/init.lua` ends with
  `require("neovimHooks")` and that `KRA_PACKAGE_ROOT` is set in your shell env
  (it is exported by `automationScripts/source-all.sh`, which the installer
  added to your shell rc).
- **Setup didn't run / want to re-run** — delete `~/.kra/.installed` and run
  any `kra` command again (the first-run fallback re-creates the skeleton, copies
  defaults, and patches your shell rc + nvim config). Your data under `~/.kra/`
  is preserved; only the marker is touched.
- **Want a portable layout** — set `KRA_HOME` (e.g. in a dotfiles repo) before
  running any `kra` command.

