-- kra_agent.util.spill — shared disk-backed content cache.
--
-- Why: two in-memory caches in the embed grow monotonically and never
-- shrink: kra_agent.diff.state.original_by_path / diff_history (full file
-- bytes per touched path + per recorded diff) and kra_agent.ui.state.history
-- (full args_json + tool result per call). Both balloon the lua heap into
-- the hundreds of MB on a long session, which is the dominant cause of the
-- nvim --embed RSS climb (~626 MB observed on a 1600-line chat).
--
-- This module spills string content to a per-process temp dir, returns a
-- SHA-1 ref, and lazy-loads it back when something actually needs it. Same
-- mechanism is mirrored on the TS side (src/AI/AIAgent/shared/utils/
-- agentHistory.ts) for the originalContent map there.
--
-- Layout:  $XDG_CACHE_HOME/nvim/kra-agent-state-nvim-<pid>/blobs/<sha>.bin
-- Cleanup: VimLeavePre autocmd + startup sweep of dirs whose pid is dead.

local M = {}

local sha1 = vim.fn.sha256
-- vim.fn.sha256 returns 64 hex chars. Not literally SHA-1, but the name is
-- only an internal detail; we just need a stable content-addressed key.

local function state_root()
    local cache = vim.fn.stdpath("cache")
    return cache .. "/kra-agent-state-nvim-" .. vim.fn.getpid()
end

local function blobs_dir()
    return state_root() .. "/blobs"
end

local ensured = false
local function ensure_dir()
    if ensured then return end
    vim.fn.mkdir(blobs_dir(), "p")
    ensured = true
end

-- Spill a string to disk; return a sha ref. Idempotent — if the same content
-- has been spilled before, we skip the write. Empty strings get a stable sha
-- and are still spilled so loaders see a real file.
function M.spill(content)
    if content == nil then return nil end
    if type(content) ~= "string" then
        content = tostring(content)
    end
    ensure_dir()
    local sha = sha1(content)
    local path = blobs_dir() .. "/" .. sha .. ".bin"
    if vim.fn.filereadable(path) == 0 then
        local f = io.open(path, "wb")
        if f then
            f:write(content)
            f:close()
        end
    end
    return sha
end

-- Load a spilled string by sha. Returns nil if the sha is missing / unreadable.
function M.load(sha)
    if sha == nil then return nil end
    local path = blobs_dir() .. "/" .. sha .. ".bin"
    local f = io.open(path, "rb")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return content
end

-- Convenience: spill a list of lines (joined with the appropriate separator)
-- and return the sha. Use crlf=true for files that were CRLF originally so a
-- subsequent load_lines round-trip matches the on-disk form.
function M.spill_lines(lines, crlf)
    if lines == nil then return nil end
    local sep = crlf and "\r\n" or "\n"
    return M.spill(table.concat(lines, sep))
end

-- Inverse of spill_lines. Returns nil if the sha is missing.
function M.load_lines(sha, crlf)
    local content = M.load(sha)
    if content == nil then return nil end
    local sep = crlf and "\r\n" or "\n"
    -- vim.split with plain=true so the CRLF separator is matched literally.
    return vim.split(content, sep, { plain = true })
end

-- Best-effort cleanup of this process's state dir. Safe to call multiple times.
function M.cleanup()
    pcall(vim.fn.delete, state_root(), "rf")
    ensured = false
end

-- Sweep state dirs whose owner pid is gone (covers SIGKILL / OOM / crashes
-- that bypass VimLeavePre). Called once at module load.
local function sweep_stale()
    local cache = vim.fn.stdpath("cache")
    local entries = vim.fn.glob(cache .. "/kra-agent-state-nvim-*", false, true)
    for _, dir in ipairs(entries) do
        local pid = tonumber(dir:match("kra%-agent%-state%-nvim%-(%d+)$"))
        if pid and pid ~= vim.fn.getpid() then
            local alive = false
            if vim.uv and vim.uv.kill then
                local ok = pcall(vim.uv.kill, pid, 0)
                alive = ok
            end
            if not alive then
                pcall(vim.fn.delete, dir, "rf")
            end
        end
    end
end

local autocmd_registered = false
local function register_autocmd()
    if autocmd_registered then return end
    autocmd_registered = true
    pcall(vim.api.nvim_create_autocmd, "VimLeavePre", {
        group = vim.api.nvim_create_augroup("KraAgentSpillCleanup", { clear = true }),
        callback = function() M.cleanup() end,
    })
end

-- Eager init at require() time: register cleanup hook and sweep stale dirs.
register_autocmd()
pcall(sweep_stale)

return M
