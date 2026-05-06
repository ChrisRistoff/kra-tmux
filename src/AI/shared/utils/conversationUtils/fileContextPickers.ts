import { NeovimClient } from "neovim";
import { formatContextPickerItem } from './fileContextDisplay';
import { fileContexts } from './fileContextStore';

export interface FilePickerSelection {
    path: string;
    isDir: boolean;
}

function parsePickerItems<T>(raw: unknown, isItem: (value: unknown) => value is T): T[] | null {
    if (typeof raw !== 'string') {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
            return null;
        }

        const items = parsed.filter(isItem);

        return items.length > 0 ? items : null;
    } catch {
        return null;
    }
}

function isFilePickerSelection(value: unknown): value is FilePickerSelection {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return typeof candidate['path'] === 'string' && typeof candidate['isDir'] === 'boolean';
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

/**
 * Telescope picker: choose a file context to remove. Resolves to the index in
 * `fileContexts` (or null if the user cancelled).
 */
export async function selectContextToRemove(nvim: NeovimClient): Promise<number[] | null> {
    const channelId = await nvim.channelId;
    const displayItems = await Promise.all(
        fileContexts.map(async (context, index) => formatContextPickerItem(context, index))
    );

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'fzf_selected_indices') {
                return;
            }

            nvim.removeListener('notification', handler);
            const value = args[0];
            if (Array.isArray(value)) {
                const indices = value
                    .map((v) => (typeof v === 'number' ? v : null))
                    .filter((v): v is number => v !== null);
                resolve(indices.length > 0 ? indices : null);

                return;
            }
            resolve(null);
        };

        nvim.on('notification', handler);

        const luaCode = `
            local items = {${displayItems.map(item => `"${item.replace(/"/g, '\\"')}"`).join(', ')}}
            local actions = require('telescope.actions')
            local action_state = require('telescope.actions.state')

            require('telescope.pickers').new({}, {
                prompt_title = 'Select Context(s) to Remove (Tab to multi-select, ESC to cancel)',
                finder = require('telescope.finders').new_table(items),
                sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local picker = action_state.get_current_picker(prompt_bufnr)
                        local multi = picker:get_multi_selection()
                        local indices = {}
                        if multi and #multi > 0 then
                            for _, entry in ipairs(multi) do
                                local idx = tonumber(string.match(entry[1], "^(%d+)"))
                                if idx then table.insert(indices, idx - 1) end
                            end
                        else
                            local selection = action_state.get_selected_entry()
                            local idx = selection and tonumber(string.match(selection[1], "^(%d+)"))
                            if idx then table.insert(indices, idx - 1) end
                        end
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'fzf_selected_indices', indices)
                    end)
                    map('i', '<Tab>', actions.toggle_selection)
                    map('n', '<Tab>', actions.toggle_selection)
                    map('i', '<S-Tab>', actions.toggle_selection)
                    map('n', '<S-Tab>', actions.toggle_selection)
                    map('i', '<Esc>', function()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'fzf_selected_indices', {})
                    end)
                    return true
                end
            }):find()
        `;

        nvim.executeLua(luaCode, []).catch(err => {
            console.error('Lua execution error:', err);
            nvim.removeListener('notification', handler);
            resolve(null);
        });
    });
}

/**
 * Telescope picker: choose any file or folder under the cwd.
 */
export async function selectFileOrFolder(nvim: NeovimClient): Promise<FilePickerSelection[] | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'unified_selection') {
                return;
            }

            nvim.removeListener('notification', handler);
            resolve(parsePickerItems(args[0], isFilePickerSelection));
        };
        nvim.on('notification', handler);

        const luaCode = `
            local ok, err = pcall(function()
                if vim.fn.executable('fzf') ~= 1 then
                    error('fzf executable not found in PATH')
                end

                local cwd = vim.fn.getcwd()
                local tmpfile = vim.fn.tempname()
                local input_file = vim.fn.tempname()

                -- Multi-repo workspace support: if the parent agent process
                -- advertised a selected repo set via KRA_SELECTED_REPO_ROOTS,
                -- enumerate every selected repo (with absolute paths so the
                -- caller can tell them apart). Falls back to the single-cwd
                -- enumeration when the env var is missing.
                local repo_roots = {}
                local repos_file = vim.env.KRA_SELECTED_REPO_ROOTS_FILE or ''
                if repos_file ~= '' and vim.fn.filereadable(repos_file) == 1 then
                    local raw = table.concat(vim.fn.readfile(repos_file), '\\n')
                    local ok_json, decoded = pcall(vim.json.decode, raw)
                    if ok_json and type(decoded) == 'table' then
                        for _, entry in ipairs(decoded) do
                            if type(entry) == 'table' and entry.alias and entry.root then
                                table.insert(repo_roots, { alias = entry.alias, root = entry.root })
                            end
                        end
                    end
                end
                if #repo_roots == 0 then
                    -- Fallback for legacy callers that set the newline-separated
                    -- env var directly (non-tmux launches inherit env from the
                    -- node process, so the inline form still works there).
                    local selected_env = vim.env.KRA_SELECTED_REPO_ROOTS or ''
                    if selected_env ~= '' then
                        for line in string.gmatch(selected_env, '[^\\n]+') do
                            local alias, root = string.match(line, '^([^\\t]+)\\t(.+)$')
                            if alias and root then
                                table.insert(repo_roots, { alias = alias, root = root })
                            end
                        end
                    end
                end

                local entries = {}
                local seen_entry = {}
                local function add_entry(p)
                    if p == nil or p == '' or p == '.' then return end
                    if not seen_entry[p] then
                        seen_entry[p] = true
                        table.insert(entries, p)
                    end
                end

                local function enumerate_repo(root)
                    if vim.fn.isdirectory(root .. '/.git') == 1 and vim.fn.executable('git') == 1 then
                        local files = vim.fn.systemlist({ 'git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard' })
                        for _, f in ipairs(files) do
                            local abs = root .. '/' .. f
                            add_entry(abs)
                            local dir = abs
                            while true do
                                dir = vim.fn.fnamemodify(dir, ':h')
                                if dir == '.' or dir == '/' or dir == '' or dir == root then break end
                                add_entry(dir)
                                if not vim.startswith(dir, root .. '/') then break end
                            end
                        end
                        add_entry(root)
                    else
                        local list_cmd
                        if vim.fn.executable('fd') == 1 then
                            list_cmd = { 'fd', '--type', 'f', '--type', 'd', '--hidden', '--follow', '--exclude', '.git', '.', root }
                        elseif vim.fn.executable('fdfind') == 1 then
                            list_cmd = { 'fdfind', '--type', 'f', '--type', 'd', '--hidden', '--follow', '--exclude', '.git', '.', root }
                        else
                            list_cmd = { 'find', root, '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*' }
                        end
                        local out = vim.fn.systemlist(list_cmd)
                        for _, p in ipairs(out) do add_entry(p) end
                    end
                end

                if #repo_roots > 0 then
                    for _, repo in ipairs(repo_roots) do
                        enumerate_repo(repo.root)
                    end
                    table.sort(entries)
                    vim.fn.writefile(entries, input_file)
                elseif vim.fn.isdirectory(cwd .. '/.git') == 1 and vim.fn.executable('git') == 1 then
                    local files = vim.fn.systemlist({ 'git', '-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard' })
                    for _, f in ipairs(files) do
                        add_entry(f)
                        local dir = f
                        while true do
                            dir = vim.fn.fnamemodify(dir, ':h')
                            if dir == '.' or dir == '/' or dir == '' then break end
                            add_entry(dir)
                        end
                    end
                    table.sort(entries)
                    vim.fn.writefile(entries, input_file)
                else
                    local list_cmd
                    if vim.fn.executable('fd') == 1 then
                        list_cmd = { 'fd', '--type', 'f', '--type', 'd', '--hidden', '--follow', '--exclude', '.git', '.', cwd }
                    elseif vim.fn.executable('fdfind') == 1 then
                        list_cmd = { 'fdfind', '--type', 'f', '--type', 'd', '--hidden', '--follow', '--exclude', '.git', '.', cwd }
                    else
                        list_cmd = { 'find', cwd, '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*' }
                    end
                    local out = vim.fn.systemlist(list_cmd)
                    vim.fn.writefile(out, input_file)
                end

                local fzf_opts = table.concat({
                    '--multi',
                    "--prompt='Files/Folders> '",
                    "--header='<Tab>: toggle multi  <CR>: confirm  <Esc>: cancel'",
                    '--height=100%',
                    '--layout=reverse',
                    '--border',
                    '--ansi',
                    "--preview='if [ -d {} ]; then ls -la {} 2>/dev/null; else (bat --style=numbers --color=always --line-range=:200 {} 2>/dev/null || cat {} 2>/dev/null); fi'",
                    '--preview-window=right:60%',
                }, ' ')

                local fzf_cmd = 'cat ' .. vim.fn.shellescape(input_file) .. ' | fzf ' .. fzf_opts .. ' > ' .. vim.fn.shellescape(tmpfile)


                local width = math.floor(vim.o.columns * 0.9)
                local height = math.floor(vim.o.lines * 0.9)
                local buf = vim.api.nvim_create_buf(false, true)
                local win = vim.api.nvim_open_win(buf, true, {
                    relative = 'editor',
                    width = width,
                    height = height,
                    col = math.floor((vim.o.columns - width) / 2),
                    row = math.floor((vim.o.lines - height) / 2),
                    style = 'minimal',
                    border = 'rounded',
                })

                vim.fn.termopen({ 'sh', '-c', fzf_cmd }, {
                    cwd = cwd,
                    on_exit = function(_, code)
                        pcall(vim.api.nvim_win_close, win, true)
                        pcall(vim.api.nvim_buf_delete, buf, { force = true })
                        pcall(os.remove, input_file)


                        if code ~= 0 then
                            pcall(os.remove, tmpfile)
                            vim.fn.rpcnotify(${channelId}, 'unified_selection', nil)
                            return
                        end

                        local lines = {}
                        if vim.fn.filereadable(tmpfile) == 1 then
                            lines = vim.fn.readfile(tmpfile)
                        end
                        pcall(os.remove, tmpfile)


                        local selected = {}
                        local seen = {}
                        for _, raw in ipairs(lines) do
                            local p = vim.fn.trim(raw)
                            if p ~= '' then
                                if p:sub(1,1) ~= '/' then
                                    p = cwd .. '/' .. p
                                end
                                local abspath = vim.fn.fnamemodify(p, ':p'):gsub('/$', '')
                                if not seen[abspath] then
                                    table.insert(selected, {
                                        path = abspath,
                                        isDir = vim.fn.isdirectory(abspath) == 1,
                                    })
                                    seen[abspath] = true
                                end
                            end
                        end

                        vim.fn.rpcnotify(${channelId}, 'unified_selection', #selected > 0 and vim.fn.json_encode(selected) or nil)
                    end,
                })
                vim.cmd('startinsert')
            end)
            if not ok then
                vim.notify('File/folder picker error: ' .. tostring(err), vim.log.levels.ERROR)
                vim.fn.rpcnotify(${channelId}, 'unified_selection', nil)
            end
        `;

        nvim.executeLua(luaCode, []).catch(() => {
            nvim.removeListener('notification', handler);
            resolve(null);
        });
    });
}


/**
 * Telescope prompt: ask whether to share the entire file/folder or a snippet.
 */
export async function promptShareMode(nvim: NeovimClient): Promise<'entire' | 'snippet' | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'share_mode_selected') {
                return;
            }

            nvim.removeListener('notification', handler);
            const shareMode = args[0];
            resolve(shareMode === 'entire' || shareMode === 'snippet' ? shareMode : null);
        };
        nvim.on('notification', handler);

        const luaCode = `
            local items = { 'Entire', 'Snippet' }
            local values = { 'entire', 'snippet' }
            local actions = require('telescope.actions')
            local action_state = require('telescope.actions.state')
            require('telescope.pickers').new({}, {
                prompt_title = 'Add to Context:',
                finder = require('telescope.finders').new_table({ results = items }),
                sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local selection = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        if not selection then
                            vim.fn.rpcnotify(${channelId}, 'share_mode_selected', nil)
                            return
                        end
                        for i, item in ipairs(items) do
                            if item == selection[1] then
                                vim.fn.rpcnotify(${channelId}, 'share_mode_selected', values[i])
                                return
                            end
                        end
                        vim.fn.rpcnotify(${channelId}, 'share_mode_selected', nil)
                    end)
                    map('i', '<Esc>', function()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'share_mode_selected', nil)
                    end)
                    return true
                end,
            }):find()
        `;

        nvim.executeLua(luaCode, []).catch(() => {
            nvim.removeListener('notification', handler);
            resolve(null);
        });
    });
}

/**
 * Telescope picker: choose one file from inside a previously-selected folder.
 */
export async function selectFileFromFolder(nvim: NeovimClient, folderPath: string): Promise<string[] | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: unknown[]): void => {
            if (method !== 'folder_file_selected') {
                return;
            }

            nvim.removeListener('notification', handler);
            resolve(parsePickerItems(args[0], isString));
        };
        nvim.on('notification', handler);

        const luaCode = `
            local ok, err = pcall(function()
                if vim.fn.executable('fzf') ~= 1 then
                    error('fzf executable not found in PATH')
                end

                local folder = ${JSON.stringify(folderPath)}
                local tmpfile = vim.fn.tempname()
                local input_file = vim.fn.tempname()

                local in_git = vim.fn.system({ 'git', '-C', folder, 'rev-parse', '--show-toplevel' })
                local is_git = vim.v.shell_error == 0 and vim.fn.trim(in_git) ~= ''

                local out
                if is_git then
                    out = vim.fn.systemlist({ 'sh', '-c', 'cd ' .. vim.fn.shellescape(folder) .. ' && git ls-files --cached --others --exclude-standard' })
                elseif vim.fn.executable('fd') == 1 then
                    out = vim.fn.systemlist({ 'fd', '--type', 'f', '--hidden', '--follow', '--exclude', '.git', '.', folder })
                elseif vim.fn.executable('fdfind') == 1 then
                    out = vim.fn.systemlist({ 'fdfind', '--type', 'f', '--hidden', '--follow', '--exclude', '.git', '.', folder })
                elseif vim.fn.executable('rg') == 1 then
                    out = vim.fn.systemlist({ 'rg', '--files', '--hidden', '--follow', '--glob', '!.git', folder })
                else
                    out = vim.fn.systemlist({ 'find', folder, '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*' })
                end
                vim.fn.writefile(out or {}, input_file)

                local fzf_opts = table.concat({
                    '--multi',
                    "--prompt='Files> '",
                    "--header='<Tab>: toggle multi  <CR>: confirm  <Esc>: cancel'",
                    '--height=100%',
                    '--layout=reverse',
                    '--border',
                    '--ansi',
                    "--preview='bat --style=numbers --color=always --line-range=:200 {} 2>/dev/null || cat {} 2>/dev/null'",
                    '--preview-window=right:60%',
                }, ' ')

                local fzf_cmd = 'cat ' .. vim.fn.shellescape(input_file) .. ' | fzf ' .. fzf_opts .. ' > ' .. vim.fn.shellescape(tmpfile)


                local width = math.floor(vim.o.columns * 0.9)
                local height = math.floor(vim.o.lines * 0.9)
                local buf = vim.api.nvim_create_buf(false, true)
                local win = vim.api.nvim_open_win(buf, true, {
                    relative = 'editor',
                    width = width,
                    height = height,
                    col = math.floor((vim.o.columns - width) / 2),
                    row = math.floor((vim.o.lines - height) / 2),
                    style = 'minimal',
                    border = 'rounded',
                })

                vim.fn.termopen({ 'sh', '-c', fzf_cmd }, {
                    cwd = folder,
                    on_exit = function(_, code)
                        pcall(vim.api.nvim_win_close, win, true)
                        pcall(vim.api.nvim_buf_delete, buf, { force = true })
                        pcall(os.remove, input_file)


                        if code ~= 0 then
                            pcall(os.remove, tmpfile)
                            vim.fn.rpcnotify(${channelId}, 'folder_file_selected', nil)
                            return
                        end

                        local lines = {}
                        if vim.fn.filereadable(tmpfile) == 1 then
                            lines = vim.fn.readfile(tmpfile)
                        end
                        pcall(os.remove, tmpfile)

                        local selected = {}
                        local seen = {}
                        for _, raw in ipairs(lines) do
                            local p = vim.fn.trim(raw)
                            if p ~= '' then
                                if p:sub(1,1) ~= '/' then
                                    p = folder .. '/' .. p
                                end
                                local abspath = vim.fn.fnamemodify(p, ':p'):gsub('/$', '')
                                if not seen[abspath] then
                                    table.insert(selected, abspath)
                                    seen[abspath] = true
                                end
                            end
                        end

                        vim.fn.rpcnotify(${channelId}, 'folder_file_selected', #selected > 0 and vim.fn.json_encode(selected) or nil)
                    end,
                })
                vim.cmd('startinsert')
            end)
            if not ok then
                vim.notify('Folder file picker error: ' .. tostring(err), vim.log.levels.ERROR)
                vim.fn.rpcnotify(${channelId}, 'folder_file_selected', nil)
            end
        `;

        nvim.executeLua(luaCode, []).catch(() => {
            nvim.removeListener('notification', handler);
            resolve(null);
        });
    });
}
