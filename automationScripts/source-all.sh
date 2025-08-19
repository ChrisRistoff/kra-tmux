#!/bin/bash
chmod +x $HOME/programming/kra-tmux/automationScripts/autocomplete/autocomplete.sh
chmod +x $HOME/programming/kra-tmux/automationScripts/hooks/tmuxHooks.sh
chmod +x $HOME/programming/kra-tmux/automationScripts/hooks/attachTmuxSession.sh

source "$HOME/programming/kra-tmux/automationScripts/autocomplete/autocomplete.sh"
source "$HOME/programming/kra-tmux/automationScripts/hooks/tmuxHooks.sh"
source "$HOME/programming/kra-tmux/automationScripts/hooks/attachTmuxSession.sh"
