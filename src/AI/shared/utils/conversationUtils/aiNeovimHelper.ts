import { StreamController } from "@/AI/shared/types/aiTypes";
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
            if exists('g:kra_agent_prompt_buf') || exists('g:kra_chat_prompt_buf')
                call rpcnotify(${channelId}, 'prompt_action', 'submit_pressed')
                return
            endif

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
    await nvim.command(`command! -nargs=0 AgentToolHistory lua require('kra_agent.ui').show_history()`);
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
            map('n', '<leader>h', '<Cmd>AgentToolHistory<CR>', vim.tbl_extend('force', opts, { desc = 'Show tool call history' }))
        `, []);

        return;
    }

    await nvim.command(`nnoremap <CR> :call SaveAndSubmit()<CR>`);
    await nvim.command(`nnoremap @ :call AddFileContext()<CR>`);
    await nvim.command(`nnoremap <C-c> :call StopStream()<CR>`);
    await nvim.command(`nnoremap f :call ShowFileContextsPopup()<CR>`);
    await nvim.command(`nnoremap <C-x> :call ClearContexts()<CR>`);
    await nvim.command(`nnoremap r :call RemoveFileContext()<CR>`);
    await nvim.command(`nnoremap <leader>h :AgentToolHistory<CR>`);
}

export async function setupChatSplitLayout(nvim: NeovimClient, channelId: number, chatFile: string): Promise<void> {
    await nvim.executeLua(`require('kra_chat_layout').setup(...)`, [channelId, chatFile]);
}

export async function getChatPromptText(nvim: NeovimClient): Promise<string> {
    const prompt = await nvim.executeLua(`return require('kra_chat_layout').get_prompt_text()`, []);

    return typeof prompt === 'string' ? prompt : '';
}

export async function clearChatPrompt(nvim: NeovimClient): Promise<void> {
    await nvim.executeLua(`require('kra_chat_layout').clear_prompt()`, []);
}

export async function focusChatPrompt(nvim: NeovimClient): Promise<void> {
    await nvim.executeLua(`require('kra_chat_layout').focus_prompt()`, []);
}

export async function refreshChatLayout(nvim: NeovimClient): Promise<void> {
    await nvim.executeLua(`require('kra_chat_layout').refresh()`, []);
}

/**
 * Fire-and-forget incremental append into the AI-chat transcript buffer.
 * See appendToAgentChatLayout in agentNeovimSetup.ts for rationale — same
 * pattern, different layout namespace.
 */
export function appendToChatLayout(nvim: NeovimClient, text: string): void {
    if (!text) return;
    try {
        nvim.notify('nvim_exec_lua', [
            `require('kra_chat_layout').append_text(...)`,
            [text],
        ]);
    } catch {
        // Best-effort UI update.
    }
}

export async function updateNvimAndGoToLastLine(nvim: NeovimClient): Promise<void> {
    await nvim.command('edit!');
    await nvim.command('normal! G');
    await nvim.command('normal! o');
}
