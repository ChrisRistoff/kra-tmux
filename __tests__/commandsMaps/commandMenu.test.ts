import { searchSelectAndReturnFromArray } from '@/UI/generalUI';
import { getCommandDefinition, pickMenuOption, resolveCommandSelection } from '@/commandsMaps/commandMenu';
import { CommandCatalog } from '@/commandsMaps/types/commandTypes';

jest.mock('@/UI/generalUI', () => ({
    searchSelectAndReturnFromArray: jest.fn(),
}));

const mockSearchSelectAndReturnFromArray = jest.mocked(searchSelectAndReturnFromArray);

const commands: CommandCatalog<'alpha' | 'beta'> = {
    alpha: { run: jest.fn(), description: 'Alpha command', details: 'Alpha details', highlights: ['Alpha feature'] },
    beta: { run: jest.fn(), description: 'Beta command', details: 'Beta details', highlights: ['Beta feature'] },
};

describe('commandMenu', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns an existing command definition without prompting', async () => {
        const result = await resolveCommandSelection({
            title: 'Pick command',
            header: 'header',
            invalidValue: 'alpha',
            invalidLabel: 'command',
            commands,
        });

        expect(result).toBe(commands.alpha);
        expect(mockSearchSelectAndReturnFromArray).not.toHaveBeenCalled();
    });

    it('prompts with descriptions when the command is missing', async () => {
        mockSearchSelectAndReturnFromArray.mockResolvedValueOnce('beta');

        const result = await resolveCommandSelection({
            title: 'Pick command',
            header: 'header',
            invalidValue: 'nope',
            invalidLabel: 'command',
            commands,
        });

        expect(result).toBe(commands.beta);
        expect(mockSearchSelectAndReturnFromArray).toHaveBeenCalledTimes(1);
        const call = mockSearchSelectAndReturnFromArray.mock.calls[0][0];
        expect(call.prompt).toBe('Pick command');
        expect(call.header).toBe('header\n\nnope is not a valid command.');
        expect(call.itemsArray).toEqual(['alpha', 'beta']);
        expect(call.showDetailsPanel).toBe(true);
        expect(call.detailsUseTags).toBe(true);
        expect(typeof call.details).toBe('function');
    });

    it('resolves option details for generic menus', async () => {
        mockSearchSelectAndReturnFromArray.mockResolvedValueOnce('alpha');

        await pickMenuOption({
            title: 'Pick group',
            header: 'workflow',
            invalidLabel: 'command group',
            options: [
                { name: 'alpha', description: 'First option', details: 'Alpha detail text', highlights: ['Alpha highlight'] },
                { name: 'beta', description: 'Second option', details: 'Beta detail text', highlights: ['Beta highlight'] },
            ],
        });

        expect(mockSearchSelectAndReturnFromArray).toHaveBeenCalledTimes(1);
        const call = mockSearchSelectAndReturnFromArray.mock.calls[0][0];
        expect(getCommandDefinition(commands, 'alpha')).toBe(commands.alpha);
        if (!call.details) {
            throw new Error('expected details callback');
        }
        expect(call.details('beta', 1)).toBe(`{cyan-fg}selected{/cyan-fg}     {bold}beta{/bold}\n{yellow-fg}summary{/yellow-fg}      Second option\n\n{green-fg}what it does{/green-fg}\nBeta detail text\n\n{magenta-fg}key features{/magenta-fg}\n {blue-fg}-{/blue-fg} Beta highlight\n\n{cyan-fg}run{/cyan-fg}          beta`);
    });
});
