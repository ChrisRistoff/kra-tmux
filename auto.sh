#!/bin/bash

_kra_completions() {
    local cur prev
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # Top-level commands after "kra"
    if [[ ${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "git tmux sys settings ai" -- "$cur") )
        return 0
    fi

    # Second-level commands after "git" or "tmux"
    if [[ "$prev" == "git" ]]; then
        COMPREPLY=( $(compgen -W "checkout create-branch open-pr view-changed restore cache-untracked retrieve-untracked hard-reset log stash stash-drop-multiple conflict-handle" -- "$cur") )
    elif [[ "$prev" == "tmux" ]]; then
        COMPREPLY=( $(compgen -W "save-server load-server list-sessions delete-server kill" -- "$cur") )
    elif [[ "$prev" == "sys" ]]; then
        COMPREPLY=( $(compgen -W "scripts grep-file-remove grep-dir-remove" -- "$cur") )
    elif [[ "$prev" == "ai" ]]; then
        COMPREPLY=( $(compgen -W "chat load delete" -- "$cur") )
    fi

    return 0
}

complete -F _kra_completions kra
