import inquirer from 'inquirer';
import { promptUserForTemperature, formatChatEntry, pickProviderAndModel } from '@AIchat/utils/aiUtils';
import * as ui from '@UI/generalUI';
import { providers } from '@AIchat/data/models';

jest.mock('inquirer');
jest.mock('@UI/generalUI', () => ({
  searchSelectAndReturnFromArray: jest.fn()
}));

describe('promptUserForTemperature', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 0.5 when selected option is "5" for a non-gemini model', async () => {
    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ selectedOption: '5' });
    const result = await promptUserForTemperature('otherModel');
    expect(result).toBe(0.5);
  });

  it('should return 2.0 when selected option is "20" for a gemini model', async () => {
    (inquirer.prompt as unknown as jest.Mock).mockResolvedValue({ selectedOption: '20' });
    const result = await promptUserForTemperature('gemini-sample');
    expect(result).toBe(2.0);
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
    const expected = `---\n### user (2020-01-01T00:00:00.000Z)\n\nHello chat\n---\n`;
    expect(result).toBe(expected);
  });

  it('should return header only if no content is provided', () => {
    const result = formatChatEntry('user', '', false);
    const expected = `---\n### user (2020-01-01T00:00:00.000Z)\n\n`;
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
    providers['providerA'] = { modelA: 'finalModelA' };
  });

  it('should pick provider and model correctly', async () => {
    (ui.searchSelectAndReturnFromArray as jest.Mock)
      .mockResolvedValueOnce('providerA')
      .mockResolvedValueOnce('modelA');

    const result = await pickProviderAndModel();
    expect(ui.searchSelectAndReturnFromArray).toHaveBeenCalledTimes(2);
    expect(ui.searchSelectAndReturnFromArray).toHaveBeenNthCalledWith(1, {
      itemsArray: Object.keys(providers),
      prompt: 'Select a provider',
    });
    expect(ui.searchSelectAndReturnFromArray).toHaveBeenNthCalledWith(2, {
      itemsArray: Object.keys(providers['providerA']),
      prompt: 'Select a model',
    });
    expect(result).toEqual({ provider: 'providerA', model: 'finalModelA' });
  });
});
