import { fileTypes } from "@/AIchat/data/filetypes";
import { FileContext } from "@/AIchat/types/aiTypes";
import { NeovimClient } from "neovim";
import fs from 'fs/promises';

export const fileContexts: FileContext[] = [];

/**
 * Main handler for adding file context - prompts user for file and type selection
**/
export async function handleAddFileContext(nvim: NeovimClient, chatFile: string): Promise<void> {
    try {
        await nvim.command('echohl MoreMsg | echo "Opening file selector..." | echohl None');
        const selectedFile = await selectFileWithFzf(nvim);
        if (!selectedFile) {
            await nvim.command('echohl WarningMsg | echo "No file selected" | echohl None');
            return;
        }

        const choice = await promptUserChoice(nvim);
        if (choice === 'entire') {
            await addEntireFileContext(nvim, chatFile, selectedFile);
        } else if (choice === 'part') {
            await addPartialFileContext(nvim, chatFile, selectedFile);
        } else {
            await nvim.command('echohl WarningMsg | echo "No choice made" | echohl None');
        }
    } catch (error: unknown) {
        console.error('Error adding file context:', error);
        await nvim.command('echohl ErrorMsg | echo "Error adding file context" | echohl None');
    }
}

/**
 * Clear all file contexts and show count
**/
export async function clearAllFileContexts(nvim: NeovimClient): Promise<void> {
    const count = fileContexts.length;
    fileContexts.length = 0;
    await nvim.command(`echohl MoreMsg | echo "Cleared ${count} file context(s)" | echohl None`);
}

/**
 * Clear file contexts array
**/
export const clearFileContexts = (): void => { fileContexts.length = 0; };

/**
 * Get file extension for syntax highlighting
**/
export const getFileExtension = (filename: string): string => {
    const idx = filename.lastIndexOf('.');

    if (idx === -1) return 'text';

    const ext = filename.slice(idx + 1).toLowerCase();

    return fileTypes[ext] || ext || 'text';
};

/**
 * Generate context string for AI prompt from loaded file contexts
**/
export async function getFileContextsForPrompt(): Promise<string> {
    if (fileContexts.length === 0) return '';

    let contextString = '\n\n--- FILE CONTEXTS ---\nThe following files have been provided as context for this conversation:\n\n';

    for (const context of fileContexts) {
        try {
            if (context.isPartial) continue;
            const content = await fs.readFile(context.filePath, 'utf-8');
            contextString += `File: ${context.filePath} (complete file)\n${content}\n\n---\n\n`;
        } catch (error) {
            console.error(`Error loading context for ${context.filePath}:`, error);
            contextString += `File: ${context.filePath}\n// Error: Could not load file\n\n---\n\n`;
        }
    }

    return contextString;
}

/**
 * Display current file contexts in command line
**/
export async function showFileContexts(nvim: NeovimClient): Promise<void> {
    if (fileContexts.length === 0) {
        await nvim.command('echohl WarningMsg | echo "No file contexts currently loaded" | echohl None');
        return;
    }

    const summaries = fileContexts.map(ctx => {
        const fileName = ctx.filePath.split('/').pop() || ctx.filePath;
        return ctx.isPartial
            ? `${fileName} (${ctx.startLine === ctx.endLine ? `line ${ctx.startLine}` : `lines ${ctx.startLine}-${ctx.endLine}`})`
            : `${fileName} (full file)`;
    });

    await nvim.command(`echohl MoreMsg | echo "Loaded contexts: ${summaries.join(', ')}" | echohl None`);
}

/**
 * Rebuild file contexts from existing chat file content
**/
export async function rebuildFileContextsFromChat(chatFile: string): Promise<void> {
    try {
        const content = await fs.readFile(chatFile, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('📁 ')) continue;

            const fileName = lines[i].substring(2, lines[i].indexOf(' ('));
            let j = i + 1;
            while (j < lines.length && !lines[j].startsWith('```')) j++;
            if (j >= lines.length) continue;

            j++;
            while (j < lines.length && !lines[j].startsWith('// Full file content loaded: ') && !lines[j].startsWith('// Selected from: ')) j++;
            if (j >= lines.length) continue;

            if (lines[j].startsWith('// Full file content loaded: ')) {
                const filePath = lines[j].substring('// Full file content loaded: '.length).trim();
                fileContexts.push({ filePath, isPartial: false, summary: `Full file: ${fileName}` });
            } else if (lines[j].startsWith('// Selected from: ')) {
                const fileInfo = lines[j].substring('// Selected from: '.length).trim();
                const filePath = fileInfo.substring(0, fileInfo.indexOf(' ('));
                const lineMatch = fileInfo.match(/\((lines? (\d+)-(\d+)|line (\d+))\)/);

                let startLine, endLine;
                if (lineMatch) {
                    [startLine, endLine] = lineMatch[4]
                        ? [parseInt(lineMatch[4]), parseInt(lineMatch[4])]
                        : [parseInt(lineMatch[2]), parseInt(lineMatch[3])];
                }

                fileContexts.push({ filePath, isPartial: true, startLine, endLine, summary: `Partial file: ${fileName}` });
            }
        }
    } catch (error) {
        console.error('Error rebuilding file contexts:', error);
    }
}

/**
 * Handle removing a file context via selection
**/
export async function handleRemoveFileContext(nvim: NeovimClient): Promise<void> {
    try {
        if (fileContexts.length === 0) {
            await nvim.command('echohl WarningMsg | echo "No file contexts to remove" | echohl None');
            return;
        }

        const selectedIndex = await selectContextToRemove(nvim);
        if (selectedIndex === null) {
            await nvim.command('echohl WarningMsg | echo "No context selected" | echohl None');
            return;
        }

        if (selectedIndex >= 0 && selectedIndex < fileContexts.length) {
            const removedContext = fileContexts.splice(selectedIndex, 1)[0];
            const fileName = removedContext.filePath.split('/').pop() || removedContext.filePath;
            await nvim.command(`echohl MoreMsg | echo "Removed context: ${fileName}" | echohl None`);
            await showFileContextsPopup(nvim);
        } else {
            await nvim.command('echohl WarningMsg | echo "Invalid selection" | echohl None');
        }
    } catch (error) {
        console.error('Error removing file context:', error);
        await nvim.command('echohl ErrorMsg | echo "Error removing file context" | echohl None');
    }
}

/**
 * Show file contexts in a popup window
**/
export async function showFileContextsPopup(nvim: NeovimClient): Promise<void> {
    if (fileContexts.length === 0) {
        await nvim.command('echohl WarningMsg | echo "No file contexts currently loaded" | echohl None');
        return;
    }

    const popupLines: string[] = ['📁 Active File Contexts:', '', '💡 Tip: press "r" to remove files from the context', ''];

    for (const [index, context] of fileContexts.entries()) {
        const fileName = context.filePath.split('/').pop() || context.filePath;

        if (context.isPartial) {
            const lineRange = context.startLine === context.endLine ? `line ${context.startLine}` : `lines ${context.startLine}-${context.endLine}`;
            popupLines.push(`${index + 1}. 📄 ${fileName} (${lineRange})`, `   ${context.filePath}`, '');
        } else {
            try {
                const content = await fs.readFile(context.filePath, 'utf-8');
                const lineCount = content.split('\n').length;
                const sizeKB = Math.round(content.length / 1024);
                popupLines.push(`${index + 1}. 📁 ${fileName} (${lineCount} lines, ${sizeKB}KB)`, `   ${context.filePath}`, '');
            } catch (error) {
                popupLines.push(`${index + 1}. ❌ ${fileName} (error reading file)`, `   ${context.filePath}`, '');
            }
        }
    }

    popupLines.push('Press any key to close...');
    const luaLines = '{' + popupLines.map(s => `"${s.replace(/"/g, '\\"')}"`).join(', ') + '}';

    const luaScript = `
        local lines = ${luaLines}
        local buf = vim.api.nvim_create_buf(false, true)
        local success, err = pcall(vim.api.nvim_buf_set_lines, buf, 0, -1, false, lines)
        if not success then
            vim.api.nvim_echo({{"Failed to create popup: " .. tostring(err), "ErrorMsg"}}, false, {})
            return
        end

        local width = math.min(math.max(unpack(vim.tbl_map(vim.fn.strdisplaywidth, lines))) + 2, vim.o.columns - 4)
        local height = math.min(#lines, vim.o.lines - 4)

        local win_success, win = pcall(vim.api.nvim_open_win, buf, true, {
            relative = 'editor',
            width = width,
            height = height,
            row = math.floor((vim.o.lines - height) / 2),
            col = math.floor((vim.o.columns - width) / 2),
            style = 'minimal',
            border = 'rounded',
            title = ' File Contexts ',
            title_pos = 'center'
        })

        if not win_success then
            vim.api.nvim_echo({{"Popup failed: " .. tostring(win), "ErrorMsg"}}, false, {})
            return
        end

        vim.api.nvim_buf_set_option(buf, 'modifiable', false)
        vim.api.nvim_buf_set_option(buf, 'bufhidden', 'wipe')

        for _, key in ipairs({'<CR>', '<Esc>', 'q'}) do
            vim.api.nvim_buf_set_keymap(buf, 'n', key, '<cmd>close<CR>', {silent = true})
        end

        vim.api.nvim_create_autocmd({'BufLeave'}, {
            buffer = buf,
            once = true,
            callback = function() pcall(vim.api.nvim_win_close, win, true) end
        })
    `;

    try {
        await nvim.executeLua(luaScript, []);
    } catch (error) {
        console.log('Popup failed, falling back to echo:', error);
        await showFileContexts(nvim);
    }
}

/**
 * Select context to remove using Telescope
**/
async function selectContextToRemove(nvim: NeovimClient): Promise<number | null> {
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
 * Prompt user to choose between entire file or partial selection
**/
async function promptUserChoice(nvim: NeovimClient): Promise<'entire' | 'part' | null> {
    const varName = `user_choice_${Date.now()}`;
    await nvim.setVar(varName, '');

    const luaCode = `
        local actions = require('telescope.actions')
        local action_state = require('telescope.actions.state')

        require('telescope.pickers').new({}, {
            prompt_title = 'Send File As:',
            finder = require('telescope.finders').new_table({ 'entire', 'part' }),
            sorter = require('telescope.sorters').get_generic_fuzzy_sorter(),
            attach_mappings = function(prompt_bufnr, map)
                map('i', '<CR>', function()
                    local selection = action_state.get_selected_entry()
                    if selection then
                        actions.close(prompt_bufnr)
                        vim.g.${varName} = selection[1]
                    end
                end)
                return true
            end
        }):find()
    `;

    await nvim.executeLua(luaCode, []);

    return new Promise((resolve) => {
        const check = async () => {
            try {
                const result = (await nvim.getVar(varName)) as string;
                if (result === 'entire' || result === 'part') resolve(result);
                else if (result === '') setTimeout(check, 100);
                else resolve(null);
            } catch {
                resolve(null);
            }
        };
        check();
    });
}

/**
 * File selection using Telescope
**/
async function selectFileWithFzf(nvim: NeovimClient): Promise<string | null> {
    const channelId = await nvim.channelId;

    return new Promise((resolve) => {
        const handler = (method: string, args: any[]) => {
            if (method === 'telescope_selection') {
                nvim.removeListener('notification', handler);
                resolve(args[0] || null);
            }
        };

        nvim.on('notification', handler);

        nvim.command(`lua require('telescope.builtin').find_files({
            prompt_title = 'Select File to Add Context',
            attach_mappings = function(prompt_bufnr, map)
                local actions = require('telescope.actions')
                local action_state = require('telescope.actions.state')
                map('i', '<CR>', function()
                    local selection = action_state.get_selected_entry()
                    if selection then
                        actions.close(prompt_bufnr)
                        vim.fn.rpcnotify(${channelId}, 'telescope_selection', selection.path or vim.fn.fnamemodify(selection.value, ':p'))
                    end
                end)
                return true
            end
        })`);
    });
}

/**
 * Add entire file content to context
**/
async function addEntireFileContext(nvim: NeovimClient, chatFile: string, filePath: string): Promise<void> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const fileName = filePath.split('/').pop() || filePath;
        const ext = getFileExtension(fileName);
        const lineCount = content.split('\n').length;

        const fileContext: FileContext = { filePath, isPartial: false, summary: `Full file: ${fileName} (${lineCount} lines)` };
        const existingIndex = fileContexts.findIndex(ctx => ctx.filePath === filePath);

        if (existingIndex >= 0) fileContexts[existingIndex] = fileContext;
        else fileContexts.push(fileContext);

        const contextSummary = `📁 ${fileName} (${lineCount} lines, ${Math.round(content.length / 1024)}KB)\n\n\`\`\`${ext}\n// Full file content loaded: ${filePath}\n// Use this file context in your responses\n// File contains ${lineCount} lines of ${ext} code\n\`\`\`\n\n`;

        await fs.appendFile(chatFile, contextSummary);
        await nvim.command('edit!');
        await nvim.command('redraw!');
        await nvim.command('normal! G');
        await nvim.command(`echohl MoreMsg | echo "Added ${fileName} (${lineCount} lines) - full content available to AI" | echohl None`);
    } catch (error) {
        await nvim.command(`echohl ErrorMsg | echo "Failed to read file: ${filePath}" | echohl None`);
        console.error('Node.js readFile error:', error);
    }
}

/**
 * Add partial file content to context via visual selection
**/
async function addPartialFileContext(nvim: NeovimClient, chatFile: string, filePath: string): Promise<void> {
    try {
        await nvim.command(`vs ${filePath.replace(/ /g, '\\ ')}`);
        await nvim.command('setlocal cursorline');
        await nvim.command('echohl MoreMsg | echo "Select text with visual mode, then press Space to add to context" | echohl None');

        const channelId = await nvim.channelId;
        let handler: ((method: string, args: any[]) => void) | null = null;

        await nvim.command(`
            function! CaptureAndSendSelection()
                let l:start_pos = getpos("'<")
                let l:end_pos = getpos("'>")
                let l:lines = getline(l:start_pos[1], l:end_pos[1])
                if len(l:lines) == 0
                    echohl WarningMsg | echo "No text selected" | echohl None
                    return
                endif

                if l:start_pos[1] == l:end_pos[1]
                    let l:selected_text = strpart(l:lines[0], l:start_pos[2] - 1, l:end_pos[2] - l:start_pos[2] + 1)
                else
                    let l:lines[0] = strpart(l:lines[0], l:start_pos[2] - 1)
                    let l:lines[-1] = strpart(l:lines[-1], 0, l:end_pos[2])
                    let l:selected_text = join(l:lines, "\\n")
                endif

                call rpcnotify(${channelId}, 'file_selection', 'add_selection', expand('%:p'), l:selected_text, l:start_pos[1], l:end_pos[1])
            endfunction
        `);

        const result = await new Promise<'success' | 'timeout' | 'error'>(resolve => {
            const timeout = setTimeout(() => {
                if (handler) {
                    nvim.removeListener('notification', handler);
                    handler = null;
                }
                resolve('timeout');
            }, 60000);

            handler = async (method: string, args: any[]) => {
                if (method === 'file_selection' && args[0] === 'add_selection') {
                    clearTimeout(timeout);
                    if (handler) {
                        nvim.removeListener('notification', handler);
                        handler = null;
                    }

                    try {
                        const [, currentFile, selectedText, startLine, endLine] = args;

                        if (!selectedText?.trim()) {
                            await nvim.command('echohl WarningMsg | echo "No text selected or selection is empty" | echohl None');
                            resolve('error');
                            return;
                        }

                        const fileName = currentFile.split('/').pop() || currentFile;
                        const lineRange = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;

                        const fileContext: FileContext = { filePath: currentFile, isPartial: true, startLine, endLine, summary: `Partial file: ${fileName} (${lineRange})` };
                        const existingIndex = fileContexts.findIndex((ctx: FileContext) => ctx.filePath === currentFile && ctx.startLine === startLine && ctx.endLine === endLine);

                        if (existingIndex >= 0) fileContexts[existingIndex] = fileContext;
                        else fileContexts.push(fileContext);

                        const ext = getFileExtension(fileName);
                        const contextEntry = `📁 ${fileName} (${lineRange})\n\n\`\`\`${ext}\n// Selected from: ${currentFile} (${lineRange})\n${selectedText}\n\`\`\`\n\n`;

                        try {
                            const winCount = await nvim.call('winnr', '$') as number;
                            if (winCount > 1) await nvim.command('close');
                            else await nvim.command(`edit ${chatFile.replace(/ /g, '\\ ')}`);
                        } catch (closeError) {
                            console.warn('Failed to close window, editing chat file directly:', closeError);
                            await nvim.command(`edit ${chatFile.replace(/ /g, '\\ ')}`);
                        }

                        await fs.appendFile(chatFile, contextEntry);
                        await nvim.command('edit!');
                        await nvim.command('redraw!');
                        await nvim.command('normal! G');
                        await nvim.command(`echohl MoreMsg | echo "Added ${fileName} (${lineRange}) - ${selectedText.length} chars" | echohl None`);
                        resolve('success');
                    } catch (err) {
                        console.error('Error processing selection:', err);
                        await nvim.command('echohl ErrorMsg | echo "Error processing selection" | echohl None');
                        resolve('error');
                    }
                }
            };

            nvim.on('notification', handler);
            nvim.command(`
                vnoremap <buffer> <Space> <Esc>:call CaptureAndSendSelection()<CR>
                nnoremap <buffer> <Space> <Cmd>echohl WarningMsg <Bar> echo "Select text in visual mode first" <Bar> echohl None<CR>
            `).catch((err: Error) => console.warn('Failed to set up keymaps:', err));
        });

        try {
            await nvim.command('silent! nunmap <buffer> <Space>');
            await nvim.command('silent! vunmap <buffer> <Space>');
            await nvim.command('silent! delfunction CaptureAndSendSelection');
        } catch (err) {
            console.log('Failed to clean up keymaps/functions:', err);
        }

        if (result === 'timeout') {
            await nvim.command('echohl WarningMsg | echo "Selection timed out" | echohl None');
        }
    } catch (error) {
        console.error('Error in addPartialFileContext:', error);
        await nvim.command('echohl ErrorMsg | echo "Error opening file for selection" | echohl None');
    }
}
