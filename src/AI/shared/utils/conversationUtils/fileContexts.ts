import { NeovimClient } from "neovim";
import fs from 'fs/promises';
import { formatContextPopupEntry, formatContextSummary } from './fileContextDisplay';
import { selectContextToRemove, selectFileOrFolder, promptShareMode, selectFileFromFolder } from './fileContextPickers';
import { addFolderContext, addEntireFileContext, addPartialFileContext, refreshTranscript } from './fileContextOps';
import type { FileContext } from '@/AI/shared/types/aiTypes';
import { clearStoredFileContexts, fileContexts, getContextFileName, getFileExtension } from './fileContextStore';

export { fileContexts, getFileExtension };

export async function handleAddFileContext(nvim: NeovimClient, chatFile: string, options?: { agentMode?: boolean }): Promise<void> {
    try {
        await nvim.command('echohl MoreMsg | echo "Opening context selector..." | echohl None');

        const selections = await selectFileOrFolder(nvim);
        if (!selections || selections.length === 0) {
            await nvim.command('echohl WarningMsg | echo "Cancelled" | echohl None');

            return;
        }

        const shareMode = await promptShareMode(nvim);
        if (!shareMode) {
            await nvim.command('echohl WarningMsg | echo "Cancelled" | echohl None');

            return;
        }

        const agentMode = options?.agentMode;

        for (const selection of selections) {
            const { path, isDir } = selection;

            if (isDir && shareMode === 'entire') {
                await addFolderContext(nvim, chatFile, path.replace(/\/$/, ''), agentMode);
                continue;
            }

            if (isDir && shareMode === 'snippet') {
                const filesInFolder = await selectFileFromFolder(nvim, path);
                if (!filesInFolder || filesInFolder.length === 0) {
                    await nvim.command('echohl WarningMsg | echo "No file selected" | echohl None');
                    continue;
                }

                for (const fileInFolder of filesInFolder) {
                    await addPartialFileContext(nvim, chatFile, fileInFolder, agentMode);
                }
                continue;
            }

            if (shareMode === 'entire') {
                await addEntireFileContext(nvim, chatFile, path, agentMode);
                continue;
            }

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
export async function clearAllFileContexts(
    nvim: NeovimClient,
    chatFile?: string,
    options?: { agentMode?: boolean }
): Promise<void> {
    const count = fileContexts.length;
    const removed = fileContexts.slice();
    clearStoredFileContexts();

    if (chatFile) {
        await removeContextEntriesFromChatFile(chatFile, removed);
        await refreshTranscript(nvim, options?.agentMode);
    }

    await nvim.command(`echohl MoreMsg | echo "Cleared ${count} file context(s)" | echohl None`);
}

/**
 * Clear file contexts array
**/
export const clearFileContexts = (): void => {
    clearStoredFileContexts();
};

/**
 * Strip the chat-file entries that were appended when each of the given
 * contexts was added. Keeps the visible chat in sync with the in-memory list
 * so the user sees adds/removes immediately.
 */
async function removeContextEntriesFromChatFile(
    chatFile: string,
    removed: FileContext[]
): Promise<void> {
    const entries = removed
        .map((ctx) => ctx.chatEntry)
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

    if (entries.length === 0) {
        return;
    }

    try {
        let content = await fs.readFile(chatFile, 'utf-8');
        for (const entry of entries) {
            const idx = content.lastIndexOf(entry);
            if (idx === -1) continue;
            content = content.slice(0, idx) + content.slice(idx + entry.length);
        }
        await fs.writeFile(chatFile, content, 'utf-8');
    } catch (error) {
        console.error('Failed to strip removed contexts from chat file:', error);
    }
}

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

    const summaries = fileContexts.map((context) => formatContextSummary(context));

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
export async function handleRemoveFileContext(
    nvim: NeovimClient,
    chatFile?: string,
    options?: { agentMode?: boolean }
): Promise<void> {
    try {
        if (fileContexts.length === 0) {
            await nvim.command('echohl WarningMsg | echo "No file contexts to remove" | echohl None');

            return;
        }

        const selectedIndices = await selectContextToRemove(nvim);
        if (!selectedIndices || selectedIndices.length === 0) {
            await nvim.command('echohl WarningMsg | echo "No context selected" | echohl None');

            return;
        }

        const validIndices = Array.from(new Set(selectedIndices))
            .filter((idx) => idx >= 0 && idx < fileContexts.length)
            .sort((a, b) => b - a);

        if (validIndices.length === 0) {
            await nvim.command('echohl WarningMsg | echo "Invalid selection" | echohl None');

            return;
        }

        const removedContexts: FileContext[] = [];
        for (const idx of validIndices) {
            removedContexts.push(fileContexts.splice(idx, 1)[0]);
        }

        if (chatFile) {
            await removeContextEntriesFromChatFile(chatFile, removedContexts);
            await refreshTranscript(nvim, options?.agentMode);
        }

        const names = removedContexts
            .map((ctx) => getContextFileName(ctx.filePath))
            .reverse()
            .join(', ');
        await nvim.command(`echohl MoreMsg | echo "Removed ${removedContexts.length} context(s): ${names}" | echohl None`);
        await showFileContextsPopup(nvim);
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
        const entryLines = await formatContextPopupEntry(context, index);
        popupLines.push(...entryLines);
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

