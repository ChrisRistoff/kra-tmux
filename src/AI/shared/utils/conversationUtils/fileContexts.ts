import { fileTypes } from "@/AI/shared/data/filetypes";
import { FileContext } from "@/AI/shared/types/aiTypes";
import { NeovimClient } from "neovim";
import fs from 'fs/promises';
import { selectContextToRemove, selectFileOrFolder, promptShareMode, selectFileFromFolder } from './fileContextPickers';
import { addFolderContext, addEntireFileContext, addPartialFileContext } from './fileContextOps';

export const fileContexts: FileContext[] = [];

export async function handleAddFileContext(nvim: NeovimClient, chatFile: string, options?: { agentMode?: boolean }): Promise<void> {
    try {
        await nvim.command('echohl MoreMsg | echo "Opening context selector..." | echohl None');

        const selection = await selectFileOrFolder(nvim);
        if (!selection) {
            await nvim.command('echohl WarningMsg | echo "Cancelled" | echohl None');

            return;
        }

        const shareMode = await promptShareMode(nvim);
        if (!shareMode) {
            await nvim.command('echohl WarningMsg | echo "Cancelled" | echohl None');

            return;
        }

        const { path, isDir } = selection;
        const agentMode = options?.agentMode;

        if (isDir && shareMode === 'entire') {
            await addFolderContext(nvim, chatFile, path.replace(/\/$/, ''), agentMode);
        } else if (isDir && shareMode === 'snippet') {
            const fileInFolder = await selectFileFromFolder(nvim, path);
            if (!fileInFolder) {
                await nvim.command('echohl WarningMsg | echo "No file selected" | echohl None');

                return;
            }
            await addPartialFileContext(nvim, chatFile, fileInFolder, agentMode);
        } else if (!isDir && shareMode === 'entire') {
            await addEntireFileContext(nvim, chatFile, path, agentMode);
        } else {
            await addPartialFileContext(nvim, chatFile, path, agentMode);
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

