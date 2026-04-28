local layout = require('kra_prompt_layout').create({
    namespace = 'kra_chat',
    prompt_buffer_name = 'kra-chat-prompt',
    prompt_winbar = ' USER PROMPT ',
    prompt_statusline = ' USER PROMPT ',
    transcript_winbar = ' CONVERSATION ',
    transcript_statusline = ' AI CHAT ',
    extend_keymaps = function(buf, channel_id)
        local map = vim.keymap.set
        local opts = { buffer = buf, silent = true }

        map('n', '@', '<Cmd>call AddFileContext()<CR>', vim.tbl_extend('force', opts, { desc = 'Add file context' }))
        map('n', '<C-c>', '<Cmd>call StopStream()<CR>', vim.tbl_extend('force', opts, { desc = 'Stop current response' }))
        map('n', 'f', '<Cmd>call ShowFileContextsPopup()<CR>', vim.tbl_extend('force', opts, { desc = 'Show active file contexts' }))
        map('n', '<C-x>', '<Cmd>call ClearContexts()<CR>', vim.tbl_extend('force', opts, { desc = 'Clear file contexts' }))
        map('n', 'r', '<Cmd>call RemoveFileContext()<CR>', vim.tbl_extend('force', opts, { desc = 'Remove a file context' }))
    end,
})

return layout
