import { deleteChats } from '@/AIchat/commands/deleteChat';
import * as fs from 'fs/promises';
import * as ui from '@/UI/generalUI';
import { aiHistoryPath } from '@/filePaths';

jest.mock('fs/promises', () => ({
    readdir: jest.fn(),
    rmdir: jest.fn()
}));

jest.mock('@/UI/generalUI', () => ({
    searchSelectAndReturnFromArray: jest.fn()
}));

jest.mock('@/utils/common', () => ({
    filterGitKeep: jest.fn((files) => files.filter((file: string) => file !== '.gitkeep'))
}));

describe('deleteChats', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should print message and not delete when no chats found', async () => {
        (fs.readdir as jest.Mock).mockResolvedValue([]);
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        await deleteChats();

        expect(consoleLogSpy).toHaveBeenCalledWith('No active chat sessions found.');
        expect(ui.searchSelectAndReturnFromArray).not.toHaveBeenCalled();

        consoleLogSpy.mockRestore();
    });

    it('should delete the selected chat', async () => {
        const chats = ['chat1', '.gitkeep'];
        (fs.readdir as jest.Mock).mockResolvedValue(chats);
        (ui.searchSelectAndReturnFromArray as jest.Mock).mockResolvedValue('chat1');
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        await deleteChats();

        expect(ui.searchSelectAndReturnFromArray).toHaveBeenCalledWith({
            itemsArray: ['chat1'],
            prompt: 'Select a chat to delete: '
        });
        expect(fs.rmdir).toHaveBeenCalledWith(`${aiHistoryPath}/chat1`, { recursive: true });
        expect(consoleLogSpy).toHaveBeenCalledWith('Chat chat1 has been deleted.');

        consoleLogSpy.mockRestore();
    });

    it('should log error and throw when fs.readdir fails', async () => {
        const error = new Error('readdir failed');
        (fs.readdir as jest.Mock).mockRejectedValue(error);
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await expect(deleteChats()).rejects.toThrow('readdir failed');
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error deleting chat:', 'readdir failed');

        consoleErrorSpy.mockRestore();
    });
});
