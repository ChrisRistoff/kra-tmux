#!/bin/bash
UPDATE_SCRIPT="$HOME/programming/kra-tmux/dest/automationScripts/autosave/autoSaveManager.js"

# session hooks
tmux set-hook -u session-created
tmux set-hook -u session-closed
tmux set-hook -u after-rename-session

tmux set-hook -g session-created "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""
tmux set-hook -g session-closed "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""
tmux set-hook -g after-rename-session "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""

# window hooks
tmux set-hook -u after-new-window
tmux set-hook -u after-rename-window

tmux set-hook -g after-new-window "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""
tmux set-hook -g after-rename-window "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""

# pane hooks
tmux set-hook -u after-split-window
tmux set-hook -u after-kill-pane
tmux set-hook -u pane-exited

tmux set-hook -g after-split-window "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""
tmux set-hook -g after-kill-pane "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""
tmux set-hook -g pane-exited "run-shell \"node $UPDATE_SCRIPT tmux >/tmp/tmux-pane-hook.log 2>&1 &\""

if [[ -n "$ZSH_VERSION" ]]; then
    # zsh
    chpwd() {
        node $UPDATE_SCRIPT tmux
    }
elif [[ -n "$BASH_VERSION" ]]; then
    # bash
    PROMPT_COMMAND="check_pwd_change; $PROMPT_COMMAND"

    check_pwd_change() {
        if [[ "$PWD" != "$LAST_PWD" ]]; then
            node $UPDATE_SCRIPT tmux
            LAST_PWD="$PWD"
        fi
    }
fi

echo "Tmux hooks installed."
