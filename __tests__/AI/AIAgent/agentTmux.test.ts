import { buildAgentTmuxCommand } from '@/AI/AIAgent/shared/utils/agentTmux';
import { neovimConfig } from '@/filePaths';

describe('buildAgentTmuxCommand', () => {
    const PROPAGATED_ENV = ['KRA_SELECTED_REPO_ROOTS_FILE', 'KRA_SEARCH_REPO_KEYS'];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = {};
        for (const key of PROPAGATED_ENV) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of PROPAGATED_ENV) {
            const value = saved[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('uses send-keys as the tmux subcommand after split-window', () => {
        const chatFile = '/tmp/kra-agent-chat.md';
        const socketPath = '/tmp/nvim-agent.sock';

        expect(buildAgentTmuxCommand(chatFile, socketPath)).toBe(
            `tmux split-window -v -p 90 -c "#{pane_current_path}" \\; send-keys -t :. 'sh -c "trap \\"exit 0\\" TERM; nvim -u \\"${neovimConfig}\\" --listen \\"${socketPath}\\" \\"${chatFile}\\"; tmux send-keys exit C-m"' C-m`
        );
    });

    it('forwards the multi-repo sidecar file and search-key env vars via -e', () => {
        process.env['KRA_SELECTED_REPO_ROOTS_FILE'] = '/tmp/kra-agent-repos-99.json';
        process.env['KRA_SEARCH_REPO_KEYS'] = 'a,b';

        const chatFile = '/tmp/kra-agent-chat.md';
        const socketPath = '/tmp/nvim-agent.sock';
        const cmd = buildAgentTmuxCommand(chatFile, socketPath);

        expect(cmd).toContain('-e KRA_SELECTED_REPO_ROOTS_FILE=/tmp/kra-agent-repos-99.json');
        expect(cmd).toContain('-e KRA_SEARCH_REPO_KEYS=a,b');
        expect(cmd.startsWith('tmux split-window -e KRA_SELECTED_REPO_ROOTS_FILE=')).toBe(true);
    });
});
