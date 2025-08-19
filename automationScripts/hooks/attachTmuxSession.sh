#!/bin/bash

preexec() {
    if [[ "$1" == "kra tmux load-server" ]]; then
        _kra_tmux_running=1
    fi
}

precmd() {
    if [[ $_kra_tmux_running == 1 ]]; then
        _kra_tmux_running=0

        while pgrep load-server > /dev/null ;do
            sleep 1
        done

        if [[ -n "TMUX" ]]; then
            echo "Attaching to tmux"
            tmux a
        fi

    fi
}
