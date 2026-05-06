import { neovimConfig } from '@/filePaths';

export function buildAgentTmuxCommand(chatFile: string, socketPath: string): string {
    // Forward the multi-repo sidecar file path (and search-key list) into the
    // new tmux pane via `-e`. The split-window pane is a fresh shell and does
    // not inherit env vars set on the parent node process post-startup, so we
    // must explicitly propagate anything Neovim/Lua needs to read.
    const envFlags: string[] = [];
    const reposFile = process.env['KRA_SELECTED_REPO_ROOTS_FILE'];
    if (reposFile) {
        envFlags.push(`-e KRA_SELECTED_REPO_ROOTS_FILE=${reposFile}`);
    }
    const searchKeys = process.env['KRA_SEARCH_REPO_KEYS'];
    if (searchKeys) {
        envFlags.push(`-e KRA_SEARCH_REPO_KEYS=${searchKeys}`);
    }
    const envSection = envFlags.length > 0 ? envFlags.join(' ') + ' ' : '';

    return `tmux split-window ${envSection}-v -p 90 -c "#{pane_current_path}" \\; send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim -u \\"${neovimConfig}\\" --listen \\"${socketPath}\\" \\"${chatFile}\\"; tmux send-keys exit C-m"' C-m`;
}
