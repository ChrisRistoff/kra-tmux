import { NeovimClient } from "neovim";
import { FileContext } from "@/AI/shared/types/aiTypes";
import fs from 'fs/promises';
import { fileContexts, getFileExtension } from './fileContexts';

const MAX_FILE_BYTES = 300_000;

/**
 * Build the chat-file summary block written when a file is added to context.
 * Agent mode keeps it tiny because the SDK attachment carries the actual content.
 */
function buildContextSummary(
    agentMode: boolean | undefined,
    fileName: string,
    filePath: string,
    ext: string,
    lineCount: number,
    sizeBytes: number,
    extraHint?: string
): string {
    if (agentMode) {
        return `# 📎 ${filePath} (${lineCount} lines, ${ext}) attached\n`;
    }

    const sizeKB = Math.round(sizeBytes / 1024);
    const hintLine = extraHint ? `// ${extraHint}\n` : '';

    return `📁 ${fileName} (${lineCount} lines, ${sizeKB}KB)\n\n\`\`\`${ext}\n// Full file content loaded: ${filePath}\n${hintLine}// File contains ${lineCount} lines of ${ext} code\n\`\`\`\n\n`;
}

/**
 * Upsert a file context entry, replacing any existing entry with the same path
 * (and, for partial entries, the same line range).
 */
function upsertFileContext(ctx: FileContext): void {
    const existingIndex = ctx.isPartial
        ? fileContexts.findIndex(c => c.filePath === ctx.filePath && c.startLine === ctx.startLine && c.endLine === ctx.endLine)
        : fileContexts.findIndex(c => c.filePath === ctx.filePath);

    if (existingIndex >= 0) fileContexts[existingIndex] = ctx;
    else fileContexts.push(ctx);
}

/**
 * Recursively collect all files inside a folder (skips hidden dirs and node_modules)
**/
async function getAllFilesInFolder(folderPath: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const fullPath = `${dir}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    files.push(fullPath);
                }
            }
        } catch {
            // skip unreadable directories
        }
    }

    await walk(folderPath);

    return files;
}

/**
 * Add all files in a folder to context (skips files larger than MAX_FILE_BYTES)
**/
export async function addFolderContext(nvim: NeovimClient, chatFile: string, folderPath: string, agentMode?: boolean): Promise<void> {
    try {
        const allFiles = await getAllFilesInFolder(folderPath);

        if (allFiles.length === 0) {
            await nvim.command('echohl WarningMsg | echo "No files found in folder" | echohl None');

            return;
        }

        let addedCount = 0;
        let totalLines = 0;

        for (const filePath of allFiles) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                if (content.length > MAX_FILE_BYTES) continue;

                const fileName = filePath.split('/').pop() || filePath;
                const ext = getFileExtension(fileName);
                const lineCount = content.split('\n').length;
                totalLines += lineCount;

                upsertFileContext({ filePath, isPartial: false, summary: `Full file: ${fileName} (${lineCount} lines)` });
                await fs.appendFile(chatFile, buildContextSummary(agentMode, fileName, filePath, ext, lineCount, content.length));
                addedCount++;
            } catch {
                // skip unreadable files
            }
        }

        const folderName = folderPath.split('/').pop() || folderPath;
        await nvim.command('edit!');
        await nvim.command('redraw!');
        await nvim.command('normal! G');
        await nvim.command(`echohl MoreMsg | echo "Added ${addedCount} files from '${folderName}' (${totalLines} total lines)" | echohl None`);
    } catch (error) {
        console.error('addFolderContext error:', error);
        await nvim.command('echohl ErrorMsg | echo "Error reading folder" | echohl None');
    }
}

/**
 * Add entire file content to context
**/
export async function addEntireFileContext(nvim: NeovimClient, chatFile: string, filePath: string, agentMode?: boolean): Promise<void> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const fileName = filePath.split('/').pop() || filePath;
        const ext = getFileExtension(fileName);
        const lineCount = content.split('\n').length;

        upsertFileContext({ filePath, isPartial: false, summary: `Full file: ${fileName} (${lineCount} lines)` });

        // In agent mode, only write a short reference — the SDK attachment delivers the actual content
        await fs.appendFile(
            chatFile,
            buildContextSummary(agentMode, fileName, filePath, ext, lineCount, content.length, 'Use this file context in your responses')
        );
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
export async function addPartialFileContext(nvim: NeovimClient, chatFile: string, filePath: string, agentMode?: boolean): Promise<void> {
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

                        upsertFileContext({ filePath: currentFile, isPartial: true, startLine, endLine, summary: `Partial file: ${fileName} (${lineRange})` });

                        const ext = getFileExtension(fileName);
                        const contextEntry = agentMode
                            ? `# 📎 ${currentFile} (${lineRange}) attached\n`
                            : `📁 ${fileName} (${lineRange})\n\n\`\`\`${ext}\n// Selected from: ${currentFile} (${lineRange})\n${selectedText}\n\`\`\`\n\n`;

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
