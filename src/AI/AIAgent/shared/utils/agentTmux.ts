import { neovimConfig } from '@/filePaths';

export function buildAgentTmuxCommand(chatFile: string, socketPath: string): string {
    return `tmux split-window -v -p 90 -c "#{pane_current_path}" \\; send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim -u \\"${neovimConfig}\\" --listen \\"${socketPath}\\" \\"${chatFile}\\"; tmux send-keys exit C-m"' C-m`;
}
