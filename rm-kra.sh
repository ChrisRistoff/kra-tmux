# 1. Uninstall the global package (try both — depending on which prefix you used)
npm uninstall -g kra-workflow
npm uninstall -g .                              # if you ever ran `npm i -g .` from the repo

# 2. Remove user data so you can verify a true fresh install
rm -rf ~/.kra
rm -f  ~/.kra/.installed                        # redundant after the rm -rf, harmless

# 3. Remove the patches the previous installer added to your dotfiles.
#    It only adds idempotent lines — safe to delete by hand:
#
#    in ~/.bashrc and ~/.zshrc, delete the line:
#       source <something>/automationScripts/source-all.sh
#
#    in ~/.config/nvim/init.lua, delete the line:
#       require("neovimHooks")
#    and the file ~/.config/nvim/lua/neovimHooks.lua
#
# Quick one-liners (read them first!):
sed -i.bak '/automationScripts\/source-all\.sh/d' ~/.bashrc ~/.zshrc 2>/dev/null
sed -i.bak '/require("neovimHooks")/d' ~/.config/nvim/init.lua 2>/dev/null
rm -f ~/.config/nvim/lua/neovimHooks.lua

# 4. (Optional) clear the legacy AI-related caches the old code used,
#    to confirm the new ~/.kra/{model-catalog,cache,quota-cache.json} get created:
rm -rf ~/.config/kra-tmux ~/.cache/kra-tmux ~/.local/share/kra-tmux

# 5. Build + pack the new tarball from the repo
cd ~/programming/kra-tmux
npm run build
npm pack                                        # produces kra-workflow-2.0.0.tgz

# 6. Install globally from the tarball
npm install -g ./kra-workflow-2.0.0.tgz

# 7. Verify
which kra
ls -la ~/.kra/                                  # should have full skeleton + .installed marker
ls $(npm root -g)/kra-workflow/ai-files/lua/    # should list kra_agent_{diff,popups,ui}.lua
kra ai                                          # or whatever launches the agent — confirm nvim opens with the UI
