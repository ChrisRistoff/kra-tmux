import { buildAgentTmuxCommand } from '@/AI/AIAgent/shared/utils/agentTmux';
import { neovimConfig } from '@/filePaths';

describe('buildAgentTmuxCommand', () => {
    it('uses send-keys as the tmux subcommand after split-window', () => {
        const chatFile = '/tmp/kra-agent-chat.md';
        const socketPath = '/tmp/nvim-agent.sock';

        expect(buildAgentTmuxCommand(chatFile, socketPath)).toBe(
            `tmux split-window -v -p 90 -c "#{pane_current_path}" \\; send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim -u \\"${neovimConfig}\\" --listen \\"${socketPath}\\" \\"${chatFile}\\"; tmux send-keys exit C-m"' C-m`
        );
    });
});
