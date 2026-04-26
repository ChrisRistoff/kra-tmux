import { promptUserForTemperature, formatChatEntry, pickProviderAndModel } from '@/AI/AIChat/utils/aiUtils';
import * as ui from '@/UI/generalUI';
import { getModelCatalog } from '@/AI/shared/data/modelCatalog';
import { SUPPORTED_PROVIDERS } from '@/AI/shared/data/providers';

jest.mock('@/UI/generalUI', () => ({
    searchSelectAndReturnFromArray: jest.fn(),
    searchAndSelect: jest.fn(),
}));

jest.mock('@/AI/shared/data/modelCatalog', () => ({
    getModelCatalog: jest.fn(),
    formatModelInfoForPicker: jest.fn((m) => m.label),
}));

describe('promptUserForTemperature', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return 0.5 when selected option is "5" for a non-gemini model', async () => {
        (ui.searchAndSelect as unknown as jest.Mock).mockResolvedValue('5');
        const result = await promptUserForTemperature('otherModel');
        expect(result).toBe(0.5);
        expect(ui.searchAndSelect).toHaveBeenCalled();
    });

    it('should return 2.0 when selected option is "20" for a gemini model', async () => {
        (ui.searchAndSelect as unknown as jest.Mock).mockResolvedValue('20');
        const result = await promptUserForTemperature('gemini-sample');
        expect(result).toBe(2.0);
        expect(ui.searchAndSelect).toHaveBeenCalled();
    });
});

describe('formatChatEntry', () => {
    beforeEach(() => {
        jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2020-01-01T00:00:00.000Z');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should return formatted entry with default header when content is provided', () => {
        const result = formatChatEntry('user', 'Hello chat', false);
        const expected = `\n---\n### user (2020-01-01T00:00:00.000Z)\n\nHello chat\n---\n`;
        expect(result).toBe(expected);
    });

    it('should return header only if no content is provided', () => {
        const result = formatChatEntry('user', '', false);
        const expected = `\n---\n### user (2020-01-01T00:00:00.000Z)\n\n`;
        expect(result).toBe(expected);
    });

    it('should use top level header when topLevel is true', () => {
        const result = formatChatEntry('user', 'Test content', true);
        const expected = `### user (2020-01-01T00:00:00.000Z)\n\nTest content\n---\n`;
        expect(result).toBe(expected);
    });
});

describe('pickProviderAndModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should pick provider and model correctly', async () => {
        (getModelCatalog as jest.Mock).mockResolvedValue([
            { id: 'finalModelA', label: 'modelA', contextWindow: 128_000 },
        ]);
        (ui.searchSelectAndReturnFromArray as unknown as jest.Mock)
            .mockResolvedValueOnce('gemini')
            .mockResolvedValueOnce('modelA');

        const result = await pickProviderAndModel();

        expect(ui.searchSelectAndReturnFromArray).toHaveBeenCalledTimes(2);
        expect(ui.searchSelectAndReturnFromArray).toHaveBeenNthCalledWith(1, {
            itemsArray: [...SUPPORTED_PROVIDERS],
            prompt: 'Select a provider',
        });
        expect(getModelCatalog).toHaveBeenCalledWith('gemini');
        expect(result).toEqual({ provider: 'gemini', model: 'finalModelA' });
    });
});
