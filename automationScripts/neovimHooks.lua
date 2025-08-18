local function setup_autosave()
  local uv = vim.loop
  local pid = vim.fn.getpid()
  local socket_path = "/tmp/nvim_" .. pid .. ".sock"
  local timer = nil
  local script_path = vim.fn.expand("~/programming/kra-tmux/dest/automationScripts/autoSaveManager.js")

  -- start one server per nvim instance
  if vim.fn.filereadable(script_path) == 0 then
    vim.notify("Autosave: Script not found", vim.log.levels.ERROR)
    return
  end
  vim.fn.serverstart(socket_path)

  -- clean up on exit
  vim.api.nvim_create_autocmd("VimLeavePre", {
    callback = function()
      vim.fn.serverstop(socket_path)
      if vim.fn.filereadable(socket_path) == 1 then
        vim.fn.delete(socket_path)
      end
    end,
  })

  -- helper: debounce + run script
  local function trigger(event)
    if timer then
      timer:stop()
      timer:close()
    end
    timer = uv.new_timer()
    timer:start(3000, 0, vim.schedule_wrap(function()
      local session = vim.fn.system("tmux display-message -p '#S'"):gsub("%s+", "")
      local window  = vim.fn.system("tmux display-message -p '#I'"):gsub("%s+", "")
      local pane    = vim.fn.system("tmux display-message -p '#P'"):gsub("%s+", "")
      local session_id = table.concat({
        "neovim", session, window, pane, event, socket_path
      }, ":")

      vim.fn.jobstart({ "node", script_path, session_id }, { detach = true })
      timer:close()
      timer = nil
    end))
  end

  -- set up autocmds
  local events = { "BufReadPost", "BufDelete", "VimLeave", "WinClosed" }
  for _, ev in ipairs(events) do
    vim.api.nvim_create_autocmd(ev, {
      callback = function()
        if ev == "VimLeave" then
          trigger(ev)
        else
          trigger(ev) -- debounced
        end
      end,
    })
  end
end