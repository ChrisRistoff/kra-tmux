import * as fs from 'fs/promises';
import * as neovim from 'neovim';
import { buildAgentTmuxCommand } from '@/AI/AIAgent/shared/utils/agentTmux';
import * as bash from '@/utils/bashHelper';
import { openVim } from '@/utils/neovimHelper';
import { neovimConfig } from '@/filePaths';
import * as aiNeovimHelper from '@/AI/shared/conversation';
import { formatUserDraftHeader } from '@/AI/shared/utils/conversationUtils/chatHeaders';
const AGENT_PROMPT_ACTIONS = [
    ['ReviewProposal', 'review_proposal'],
    ['OpenProposalFile', 'open_proposal_file'],
    ['ApplyProposal', 'apply_proposal'],
    ['RejectProposal', 'reject_proposal'],
] as const;


export async function createAgentChatFile(chatFile: string): Promise<void> {
    const initialContent = `# Copilot Agent Chat

            This session runs the Copilot SDK against a proposal workspace. Proposed edits are reviewed in Neovim before they are applied to the repository.

            # Controls / Shortcuts:
            #   Enter        -> Submit prompt
            #   Tab / S-Tab  -> Switch between transcript and prompt
            #   Ctrl+c       -> Stop current agent turn
            #   @            -> Add file context(s) (<Tab> multi-select, + marks selections, <CR> confirm, <Esc> cancel)
            #   r            -> Remove file from context
            #   f            -> Show active file contexts
            #   Ctrl+x       -> Clear all contexts
            #   <leader>t    -> Toggle popups for tools and agent current actions on/off
            #
            # Proposal controls (shown automatically after each turn with changes):
            #   <leader>o    -> Open a changed proposal file
            #   <leader>a    -> Apply proposal to the repository
            #   <leader>r    -> Reject proposal
            #
            # Agent controls:
            #   <leader>y    -> Toggle YOLO mode (auto-approve all tools)
            #   <leader>P    -> Reset remembered tool approvals
            #   <leader>h    -> Browse recent tool calls
            #   <leader>s    -> Browse session diff history (all AI write diffs)
            #   <leader>m    -> Browse kra-memory (<Tab> view, a add, dd del; <CR> opens entry buffer: <leader>w save / d del / r resolve / x dismiss / q close)
            #   <leader>i    -> Reopen the kra-memory index-progress modal
            #   <leader>?    -> Show all keymaps
            #
            # 💡 Type your prompt in the bottom split.`;

    await fs.writeFile(chatFile, `${initialContent}${formatUserDraftHeader()}`, 'utf8');
}

export async function addAgentCommands(nvimClient: neovim.NeovimClient): Promise<void> {
    for (const [commandName] of AGENT_PROMPT_ACTIONS) {
        await nvimClient.command(`command! -nargs=0 ${commandName} call ${commandName}()`);
    }

    await nvimClient.command(`command! -nargs=0 AgentToolHistory lua require('kra_agent_ui').show_history()`);
    await nvimClient.command(`command! -nargs=0 AgentCommands lua require('which-key').show({ global = false })`);
}

export async function addAgentFunctions(nvimClient: neovim.NeovimClient, channelId: number): Promise<void> {
    for (const [functionName, actionName] of AGENT_PROMPT_ACTIONS) {
        await nvimClient.command(`
            function! ${functionName}()
                call rpcnotify(${channelId}, 'prompt_action', '${actionName}')
            endfunction
        `);
    }
}

export async function setupAgentSplitLayout(
    nvimClient: neovim.NeovimClient,
    channelId: number
): Promise<void> {
    await nvimClient.executeLua(`require('kra_agent_layout').setup(...)`, [channelId]);
}



export async function getAgentPromptText(nvimClient: neovim.NeovimClient): Promise<string> {
    const prompt = await nvimClient.executeLua(`return require('kra_agent_layout').get_prompt_text()`, []);

    return typeof prompt === 'string' ? prompt : '';
}

export async function clearAgentPrompt(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.executeLua(`require('kra_agent_layout').clear_prompt()`, []);
}

export async function focusAgentPrompt(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.executeLua(`require('kra_agent_layout').focus_prompt()`, []);
}

export async function refreshAgentLayout(nvimClient: neovim.NeovimClient): Promise<void> {
    await nvimClient.executeLua(`require('kra_agent_layout').refresh()`, []);
}

export async function openAgentNeovim(chatFile: string): Promise<neovim.NeovimClient> {
    const socketPath = await aiNeovimHelper.generateSocketPath();

    if (process.env.TMUX) {
        await bash.execCommand(buildAgentTmuxCommand(chatFile, socketPath));
    } else {
        void openVim(chatFile, '-u', neovimConfig, '--listen', socketPath);
    }

    await aiNeovimHelper.waitForSocket(socketPath);

    return neovim.attach({ socket: socketPath });
}
