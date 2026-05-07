import { getAsciiHelp, isHelpFlag } from '@/utils/cliHelp';

describe('cliHelp', () => {
    it('recognizes supported help flags', () => {
        expect(isHelpFlag('-help')).toBe(true);
        expect(isHelpFlag('--help')).toBe(true);
        expect(isHelpFlag('-h')).toBe(true);
        expect(isHelpFlag('help')).toBe(false);
        expect(isHelpFlag(undefined)).toBe(false);
    });

    it('returns top-level help when no group is provided', () => {
        expect(getAsciiHelp()).toContain('Help: kra <group> -help');
        expect(getAsciiHelp()).toContain('| tmux     |');
    });

    it('returns group-specific help banners', () => {
        expect(getAsciiHelp('git')).toContain('| checkout');
        expect(getAsciiHelp('tmux')).toContain('| manage-server');
        expect(getAsciiHelp('ai')).toContain('| quota-agent');
        expect(getAsciiHelp('sys')).toContain('| grep');
        expect(getAsciiHelp('settings')).toContain('Use: kra settings');
    });
});
