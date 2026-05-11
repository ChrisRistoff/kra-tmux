/**
 * Diff review — opens the user's real `nvim -d` (vimdiff) on top of the
 * blessed TUI. The blessed alternate buffer is paused while nvim owns
 * the TTY, then restored on exit.
 *
 * Verdict protocol:
 *   We write a tiny Lua shim into a temp file and inject it via
 *   `nvim -c "luafile <shim>"`. The shim sets keymaps in the proposed
 *   (right-hand) buffer:
 *     <Space>a  approve  → save proposed buffer + write verdict, :qa
 *     <Space>d  deny     → prompt for reason + write verdict, :qa!
 *     q / <Space>q       → cancel + write verdict, :qa!
 *   On nvim exit the parent reads the verdict file. If the file is
 *   missing/unreadable (e.g. user quit with :q!) we treat it as cancel.
 */
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as blessed from 'blessed';
import { pauseScreen } from '@/UI/dashboard/screen';

export interface DiffReviewInput {
    /** Display path shown in the title. */
    displayPath: string;
    /** Current on-disk content (may be empty for new files). */
    currentContent: string;
    /** AI-proposed content. */
    proposedContent: string;
    /** Hint shown next to the title (optional). */
    note?: string;
    /** Tool name for the title. */
    toolName: string;
    /** Whether the proposed content ends with a newline (for join semantics). */
    proposedEndsWithNewline: boolean;
}

export type DiffReviewResult =
    | { kind: 'approve', editedContent: string, userEdited: boolean }
    | { kind: 'deny', reason?: string }
    | { kind: 'edit-json' }
    | { kind: 'cancel' };

interface VerdictFile {
    action?: 'approve' | 'deny' | 'cancel';
    reason?: string;
}

function buildLuaShim(verdictPath: string, proposedPath: string, displayPath: string, note: string | undefined): string {
    // The shim runs after `nvim -d <current> <proposed>` has loaded.
    // It identifies the proposed buffer by full path so it works
    // regardless of which window nvim opened it in first.
    // All paths are JSON-encoded so embedded quotes/backslashes survive.
    const propJ = JSON.stringify(proposedPath);
    const verdictJ = JSON.stringify(verdictPath);
    const titleJ = JSON.stringify(`Diff: ${displayPath}${note ? `  ⚠ ${note}` : ''}`);

    return `
local verdict_path = ${verdictJ}
local proposed_path = ${propJ}
local title = ${titleJ}

-- Resolve the buffer for the proposed (right-hand) file.
-- macOS symlinks /var → /private/var, so a plain string compare on
-- :p paths can miss. Canonicalise both sides with fs_realpath, and
-- as a final fallback fall back to the LAST argv entry (which is
-- always the proposed file the way we invoke nvim).
local uv = vim.uv or vim.loop
local function realpath(p)
    if not p or p == '' then return p end
    local ok, rp = pcall(uv.fs_realpath, p)
    if ok and rp then return rp end
    return vim.fn.fnamemodify(p, ':p')
end

local function proposed_buf()
    local target = realpath(proposed_path)
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) then
            local n = vim.api.nvim_buf_get_name(b)
            if n ~= '' and realpath(n) == target then return b end
        end
    end
    -- Fallback: the last argv entry is the proposed file.
    local args = vim.fn.argv()
    if type(args) == 'table' and #args > 0 then
        local last = args[#args]
        local nr = vim.fn.bufnr(last)
        if nr ~= -1 then return nr end
    end
    return nil
end

local function write_verdict(tbl)
    local ok, encoded = pcall(vim.json.encode, tbl)
    if not ok then encoded = '{"action":"cancel"}' end
    local f = io.open(verdict_path, 'w')
    if f then f:write(encoded); f:close() end
end

-- Pre-write a "cancel" verdict so an unexpected quit (:q!, ZQ, crash)
-- naturally resolves as cancel rather than hanging the parent.
write_verdict({ action = 'cancel' })

local function focus_proposed()
    local pb = proposed_buf()
    if not pb then return false end
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_buf(win) == pb then
            vim.api.nvim_set_current_win(win)
            return true
        end
    end
    return false
end

local function approve()
    local pb = proposed_buf()
    if not pb then
        vim.notify('Diff: could not locate proposed buffer', vim.log.levels.ERROR)
        return
    end
    -- Save the (possibly-edited) proposed buffer to disk so the parent
    -- can read it back as the approved content.
    local cur = vim.api.nvim_get_current_buf()
    vim.api.nvim_set_current_buf(pb)
    pcall(vim.cmd, 'silent! write!')
    vim.api.nvim_set_current_buf(cur)
    write_verdict({ action = 'approve' })
    vim.cmd('qa!')
end

local function deny()
    local reason = vim.fn.input('Deny reason (optional): ')
    write_verdict({ action = 'deny', reason = reason })
    vim.cmd('qa!')
end

local function cancel()
    write_verdict({ action = 'cancel' })
    vim.cmd('qa!')
end

-- Set keymaps globally so they fire from either window.
local opts = { silent = true, nowait = true }
vim.keymap.set('n', '<leader>a', approve, vim.tbl_extend('force', opts, { desc = 'Diff: approve' }))
vim.keymap.set('n', '<leader>d', deny,    vim.tbl_extend('force', opts, { desc = 'Diff: deny' }))
vim.keymap.set('n', '<leader>q', cancel,  vim.tbl_extend('force', opts, { desc = 'Diff: cancel' }))
vim.keymap.set('n', 'q',         cancel,  vim.tbl_extend('force', opts, { desc = 'Diff: cancel' }))
vim.keymap.set('n', 'ZZ',        approve, vim.tbl_extend('force', opts, { desc = 'Diff: approve (ZZ)' }))
vim.keymap.set('n', 'ZQ',        cancel,  vim.tbl_extend('force', opts, { desc = 'Diff: cancel (ZQ)' }))

-- Land focus on the proposed (editable) side and show a one-line hint.
focus_proposed()
vim.cmd('echohl ModeMsg | echo ' .. vim.fn.string(title) ..
        ' | echohl None')
vim.defer_fn(function()
    vim.api.nvim_echo({
        { '<Space>a', 'Question' }, { ' approve  ', 'Normal' },
        { '<Space>d', 'Question' }, { ' deny  ', 'Normal' },
        { 'q', 'Question' },        { ' cancel', 'Normal' },
    }, false, {})
end, 50)
`;
}

async function readVerdict(verdictPath: string): Promise<VerdictFile> {
    try {
        const raw = await fsp.readFile(verdictPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') return parsed as VerdictFile;
    } catch { /* fall through */ }

    return { action: 'cancel' };
}

function writeFromBuffer(buf: string, endsWithNewline: boolean): string {
    // nvim's `:write` honours fileformat — we always read raw bytes.
    // If the original ended without a newline but vim added one (eol),
    // strip it so the round-trip is byte-identical.
    if (!endsWithNewline && buf.endsWith('\n')) return buf.slice(0, -1);

    return buf;
}

export async function showDiffReviewModal(
    screen: blessed.Widgets.Screen,
    input: DiffReviewInput,
): Promise<DiffReviewResult> {
    // Stage temp files. We honour the proposed file's real extension so
    // nvim's filetype detection (and the user's plugins) pick the right
    // syntax/lsp/formatter.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kra-diff-'));
    const ext = path.extname(input.displayPath) || '';
    const baseName = path.basename(input.displayPath, ext) || 'file';
    const currentPath = path.join(tmpDir, `${baseName}.current${ext}`);
    const proposedPath = path.join(tmpDir, `${baseName}.proposed${ext}`);
    const verdictPath = path.join(tmpDir, 'verdict.json');
    const shimPath = path.join(tmpDir, 'shim.lua');

    await fsp.writeFile(currentPath, input.currentContent, 'utf8');
    await fsp.writeFile(proposedPath, input.proposedContent, 'utf8');
    // Canonicalise paths (macOS /var → /private/var symlink) so the
    // shim's buffer-name comparison can't miss.
    const currentReal = await fsp.realpath(currentPath).catch(() => currentPath);
    const proposedReal = await fsp.realpath(proposedPath).catch(() => proposedPath);
    await fsp.writeFile(shimPath, buildLuaShim(verdictPath, proposedReal, input.displayPath, input.note), 'utf8');

    const restore = pauseScreen(screen);
    const exitCode = await new Promise<number>((resolve) => {
        // `-d` opens vimdiff. `-R` would make the LEFT side read-only —
        // vimdiff doesn't support per-window readonly via flag, so we
        // rely on the user not editing the left buffer (it's labelled
        // CURRENT and never written back).
        const child = spawn('nvim', [
            '-d',
            currentReal,
            proposedReal,
            '-c', `luafile ${shimPath}`,
        ], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(typeof code === 'number' ? code : 1));
        child.on('error', () => resolve(1));
    });
    restore();

    let result: DiffReviewResult;
    try {
        const verdict = await readVerdict(verdictPath);
        if (verdict.action === 'approve') {
            const edited = await fsp.readFile(proposedReal, 'utf8');
            const editedContent = writeFromBuffer(edited, input.proposedEndsWithNewline);
            result = {
                kind: 'approve',
                editedContent,
                userEdited: editedContent !== input.proposedContent,
            };
        } else if (verdict.action === 'deny') {
            const reason = (verdict.reason ?? '').trim();
            result = reason ? { kind: 'deny', reason } : { kind: 'deny' };
        } else {
            result = { kind: 'cancel' };
        }
    } catch {
        result = { kind: 'cancel' };
    }

    // Best-effort cleanup; never fail the review on tmp removal issues.
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* noop */ });
    void exitCode;

    return result;
}
