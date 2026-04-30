import { aiAscii } from '@/AI/shared/data/ai-ascii';
import { CommandType } from '@/commandsMaps/types/commandTypes';
import { settingsAscii } from '@/data/settings-ascii';
import { workflowAscii } from '@/data/workflow-ascii';
import { gitAscii } from '@/git/data/git-ascii';
import { sysAscii } from '@/system/data/sys-ascii';
import { tmuxAscii } from '@/tmux/data/tmux-ascii';

const HELP_FLAGS = new Set(['-help', '--help', '-h']);

export function isHelpFlag(value?: string): boolean {
    return typeof value === 'string' && HELP_FLAGS.has(value);
}

export function getAsciiHelp(commandType?: CommandType): string {
    switch (commandType) {
        case 'git':
            return gitAscii;
        case 'tmux':
            return tmuxAscii;
        case 'ai':
            return aiAscii;
        case 'sys':
            return sysAscii;
        case 'settings':
            return settingsAscii;
        default:
            return workflowAscii;
    }
}
