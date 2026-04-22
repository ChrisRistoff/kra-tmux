import { NeovimClient } from "neovim";
import { FileContext } from "@/AI/shared/types/aiTypes";
import fs from 'fs/promises';
import { fileContexts } from './fileContexts';

/**
 * Telescope picker: choose a file context to remove. Resolves to the index in
 * `fileContexts` (or null if the user cancelled).
 */
export async function selectContextToRemove(nvim: NeovimClient): Promise<number | null> {
    const channelId = await nvim.channelId;
    const displayItems = await Promise.all(fileContexts.map(async (context: FileContext, index: number) => {
        const fileName = context.filePath.split('/').pop() || context.filePath;

        if (context.isPartial) {
            const lineRange = context.startLine === context.endLine ? `line ${context.startLine}` : `lines ${context.startLine}-${context.endLine}`;

            return `${index + 1}. 📄 ${fileName} (${lineRange})`;
        }

        try {
            const content = await fs.readFile(context.filePath, 'utf-8');
            const lineCount = content.split('\n').length;
            const sizeKB = Math.round(content.length / 1024);

            return `${index + 1}. 📁 ${fileName} (${lineCount} lines, ${sizeKB}KB)`;
        } catch (error) {
            return `${index + 1}. ❌ ${fileName} (error reading file)`;
        }
    }));

    return new Promise((resolve) => {
        const handler = (method: string, args: any[]) => {
            if (method === 'fzf_selected_index') {
                nvim.removeListener('notification', handler);
                resolve(args[0] !== undefined ? args[0] : null);
            }
        };

        nvim.on('notification', handler);

        const luaCode = `
            local items = {${displayItems.map(item => `"${item.replace(/"/g, '\\"')}"`).join(', ')}}
            local actions = require('telescope.actions')
            local action_state = require('telescope.actions.state')

            require('telescope.pickers').new({}, {
                prompt_title = 'Select Context to Remove (ESC to cancel)',
                finder = require('telescope.finders').new_table(items),
                sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
                attach_mappings = function(prompt_bufnr, map)
                    actions.select_default:replace(function()
                        local selection = action_state.get_selected_entry()
                        actions.close(prompt_bufnr)
                        local index = selection and tonumber(string.match(selection[1], "^(%d+)"))
                        vim.fn.rpcnotify(${channelId}, 'fzf_selected_index', index and index - 1 or nil)
                    end)
                    map('i', '<Esc>', function()
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'fzf_selected_index', nil)
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
export async function selectFileOrFolder(nvim: NeovimClient): Promise<{ path: string; isDir: boolean } | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: any[]) => {
            if (method === 'unified_selection') {
                nvim.removeListener('notification', handler);
                const path: string = args[0];
                const isDir: boolean = args[1] === true;
                resolve(path ? { path, isDir } : null);
            }
        };
        nvim.on('notification', handler);

        const luaCode = `
            local ok, err = pcall(function()
                local actions = require('telescope.actions')
                local action_state = require('telescope.actions.state')
                local pickers = require('telescope.pickers')
                local finders = require('telescope.finders')
                local conf = require('telescope.config').values
                local make_entry = require('telescope.make_entry')

                local find_cmd
                if vim.fn.executable('fd') == 1 then
                    find_cmd = { 'fd', '--hidden', '--follow',
                                 '--exclude', '.git', '--exclude', 'node_modules' }
                else
                    find_cmd = { 'find', '.',
                                 '-not', '-path', '*/.git/*',
                                 '-not', '-path', '*/node_modules/*' }
                end

                pickers.new({}, {
                    prompt_title = 'Select File or Folder',
                    finder = finders.new_oneshot_job(find_cmd, {
                        entry_maker = make_entry.gen_from_file({}),
                    }),
                    sorter = conf.file_sorter({}),
                    previewer = conf.file_previewer({}),
                    attach_mappings = function(prompt_bufnr, _)
                        actions.select_default:replace(function()
                            local selection = action_state.get_selected_entry()
                            actions.close(prompt_bufnr)
                            if not selection then
                                vim.fn.rpcnotify(${channelId}, 'unified_selection', nil, false)
                                return
                            end
                            local path = vim.fn.fnamemodify(selection.value or '', ':p')
                            local is_dir = vim.fn.isdirectory(path) == 1
                            vim.fn.rpcnotify(${channelId}, 'unified_selection', path, is_dir)
                        end)
                        return true
                    end,
                }):find()
            end)
            if not ok then
                vim.notify('File/folder picker error: ' .. tostring(err), vim.log.levels.ERROR)
                vim.fn.rpcnotify(${channelId}, 'unified_selection', nil, false)
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
        const handler = (method: string, args: any[]) => {
            if (method === 'share_mode_selected') {
                nvim.removeListener('notification', handler);
                resolve((args[0] as 'entire' | 'snippet') || null);
            }
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
export async function selectFileFromFolder(nvim: NeovimClient, folderPath: string): Promise<string | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: any[]) => {
            if (method === 'folder_file_selected') {
                nvim.removeListener('notification', handler);
                resolve(args[0] || null);
            }
        };
        nvim.on('notification', handler);

        const luaCode = `
            local ok, err = pcall(function()
                local actions = require('telescope.actions')
                local action_state = require('telescope.actions.state')
                local pickers = require('telescope.pickers')
                local finders = require('telescope.finders')
                local conf = require('telescope.config').values
                local make_entry = require('telescope.make_entry')

                local folder = ${JSON.stringify(folderPath)}
                local find_cmd
                if vim.fn.executable('fd') == 1 then
                    find_cmd = { 'fd', '.', '--type', 'f', '--hidden', folder }
                else
                    find_cmd = { 'find', folder, '-type', 'f' }
                end

                pickers.new({}, {
                    prompt_title = 'Select File from Folder',
                    cwd = folder,
                    finder = finders.new_oneshot_job(find_cmd, {
                        entry_maker = make_entry.gen_from_file({}),
                    }),
                    sorter = conf.file_sorter({}),
                    previewer = conf.file_previewer({}),
                    attach_mappings = function(prompt_bufnr, _)
                        actions.select_default:replace(function()
                            local selection = action_state.get_selected_entry()
                            actions.close(prompt_bufnr)
                            if not selection then
                                vim.fn.rpcnotify(${channelId}, 'folder_file_selected', nil)
                                return
                            end
                            local path = vim.fn.fnamemodify(selection.value or '', ':p')
                            vim.fn.rpcnotify(${channelId}, 'folder_file_selected', path)
                        end)
                        return true
                    end,
                }):find()
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
