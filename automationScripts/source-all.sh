#!/bin/bash
# Resolve the kra-workflow package root from this script's own location.
if [ -n "${BASH_SOURCE[0]}" ]; then
    _kra_self="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION-}" ]; then
    _kra_self="${(%):-%x}"
else
    _kra_self="$0"
fi
export KRA_PACKAGE_ROOT="$(cd "$(dirname "$_kra_self")/.." && pwd)"
unset _kra_self

chmod +x "$KRA_PACKAGE_ROOT/automationScripts/autocomplete/autocomplete.sh"
chmod +x "$KRA_PACKAGE_ROOT/automationScripts/hooks/tmuxHooks.sh"
chmod +x "$KRA_PACKAGE_ROOT/automationScripts/hooks/attachTmuxSession.sh"

source "$KRA_PACKAGE_ROOT/automationScripts/autocomplete/autocomplete.sh"
source "$KRA_PACKAGE_ROOT/automationScripts/hooks/tmuxHooks.sh"
source "$KRA_PACKAGE_ROOT/automationScripts/hooks/attachTmuxSession.sh"
