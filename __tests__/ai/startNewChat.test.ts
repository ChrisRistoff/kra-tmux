import { startNewChat } from '@/AIchat/commands/startNewChat';
import * as conversation from '@/AIchat/main/conversation';
import * as utils from '@/AIchat/utils/aiUtils';
import * as ui from '@/UI/generalUI';
import { aiRoles } from '@/AIchat/data/roles';

jest.mock('@/AIchat/main/conversation');
jest.mock('@/UI/generalUI');
jest.mock('@/AIchat/utils/aiUtils');

describe('startNewChat', () => {
    const fixedTimestamp = 1000;
    const chatFile = `/tmp/ai-chat-${fixedTimestamp}.md`;
    const roleSelection = 'userRole';
    const provider = 'dummyProvider';
    const model = 'dummyModel';
    const temperature = 0.7;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Date, 'now').mockReturnValue(fixedTimestamp);

        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue(roleSelection);
        (utils.pickProviderAndModel as jest.Mock).mockResolvedValue({ provider, model });
        (utils.promptUserForTemperature as jest.Mock).mockResolvedValue(temperature);
        (conversation.converse as jest.Mock).mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should start a new chat successfully', async () => {
        await startNewChat();

        // ui.searchSelectAndReturnFromArray was called with the expected parameters.
        expect(ui.searchSelectAndReturnFromArray).toHaveBeenCalledWith({
            itemsArray: Object.keys(aiRoles),
            prompt: 'Select a role from the list: '
        });

        // provider and model have been picked
        expect(utils.pickProviderAndModel).toHaveBeenCalled();

        // temperature was prompted
        expect(utils.promptUserForTemperature).toHaveBeenCalledWith(model);

        // conversation is started with the proper arguments
        expect(conversation.converse).toHaveBeenCalledWith(chatFile, temperature, roleSelection, provider, model);
    });

    it('should throw error and log error if an error occurs', async () => {
        const testError = new Error('Test Error');
        (conversation.converse as jest.Mock).mockRejectedValue(testError);

        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await expect(startNewChat()).rejects.toThrow('Test Error');

        expect(consoleErrorSpy).toHaveBeenCalledWith('Error in AI prompt workflow:', 'Test Error');

        consoleErrorSpy.mockRestore();
    });
});
