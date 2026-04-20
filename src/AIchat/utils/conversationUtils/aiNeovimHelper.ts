import { StreamController } from "@/AIchat/types/aiTypes";
import { NeovimClient } from "neovim";
import os from 'os';
import * as fs from 'fs/promises';

export async function handleStopStream(currentStreamController: StreamController | null, nvim: NeovimClient): Promise<void> {
    if (currentStreamController && !currentStreamController.isAborted) {
        currentStreamController.abort();
        await nvim.command('echohl WarningMsg | echo "Generation stopped" | echohl None');
    } else {
        await nvim.command('echohl WarningMsg | echo "No active generation to stop" | echohl None');
    }
}

export async function generateSocketPath(): Promise<string> {
    const randomString = Math.random().toString(36).substring(2, 15);
    return `${os.tmpdir()}/nvim-${randomString}.sock`;
}

export async function waitForSocket(socketPath: string, timeout = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            await fs.access(socketPath);
            return true;
        } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    return false;
}

export async function addNeovimFunctions(nvim: NeovimClient, channelId: number): Promise<void> {
    await nvim.command(`
        function! SaveAndSubmit()
            write
            call rpcnotify(${channelId}, 'prompt_action', 'submit_pressed')
        endfunction
    `);

    await nvim.command(`
        function! AddFileContext()
            call rpcnotify(${channelId}, 'prompt_action', 'add_file_context')
        endfunction
    `);

    await nvim.command(`
        function! StopStream()
            call rpcnotify(${channelId}, 'prompt_action', 'stop_stream')
        endfunction
    `);

    await nvim.command(`
        function! ShowFileContextsPopup()
            call rpcnotify(${channelId}, 'prompt_action', 'show_contexts_popup')
        endfunction
    `);

    await nvim.command(`
        function! RemoveFileContext()
            call rpcnotify(${channelId}, 'prompt_action', 'remove_file_context')
        endfunction
    `);

    await nvim.command(`
        function! ClearContexts()
            call rpcnotify(${channelId}, 'prompt_action', 'clear_contexts')
        endfunction
    `);
}

export async function addCommands(nvim: NeovimClient): Promise<void> {
    await nvim.command(`command! -nargs=0 SubmitPrompt call SaveAndSubmit()`);
    await nvim.command(`command! -nargs=0 AddFile call AddFileContext()`);
    await nvim.command(`command! -nargs=0 StopGeneration call StopStream()`);
    await nvim.command(`command! -nargs=0 ClearContexts call ClearContexts()`);
    await nvim.command(`command! -nargs=0 RemoveFileContext call RemoveFileContext()`);
}

export async function setupKeyBindings(nvim: NeovimClient): Promise<void> {
    if ('executeLua' in nvim && typeof nvim.executeLua === 'function') {
        // Global keymaps — no buffer=0 so they work regardless of which buffer is
        // current when this runs (timing with lazy.nvim startup is non-deterministic).
        await nvim.executeLua(`
            local map = vim.keymap.set
            local opts = { silent = true }
            map('n', '<CR>', '<Cmd>call SaveAndSubmit()<CR>', vim.tbl_extend('force', opts, { desc = 'Submit user prompt' }))
            map('n', '@', '<Cmd>call AddFileContext()<CR>', vim.tbl_extend('force', opts, { desc = 'Add file context' }))
            map('n', '<C-c>', '<Cmd>call StopStream()<CR>', vim.tbl_extend('force', opts, { desc = 'Stop current agent turn' }))
            map('n', 'f', '<Cmd>call ShowFileContextsPopup()<CR>', vim.tbl_extend('force', opts, { desc = 'Show active file contexts' }))
            map('n', '<C-x>', '<Cmd>call ClearContexts()<CR>', vim.tbl_extend('force', opts, { desc = 'Clear file contexts' }))
            map('n', 'r', '<Cmd>call RemoveFileContext()<CR>', vim.tbl_extend('force', opts, { desc = 'Remove a file context' }))
        `, []);
        return;
    }

    await nvim.command(`nnoremap <CR> :call SaveAndSubmit()<CR>`);
    await nvim.command(`nnoremap @ :call AddFileContext()<CR>`);
    await nvim.command(`nnoremap <C-c> :call StopStream()<CR>`);
    await nvim.command(`nnoremap f :call ShowFileContextsPopup()<CR>`);
    await nvim.command(`nnoremap <C-x> :call ClearContexts()<CR>`);
    await nvim.command(`nnoremap r :call RemoveFileContext()<CR>`);
}

export async function updateNvimAndGoToLastLine(nvim: NeovimClient): Promise<void> {
    await nvim.command('edit!');
    await nvim.command('normal! G');
    await nvim.command('normal! o');
}
