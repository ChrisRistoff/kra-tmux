import * as fs from 'fs/promises';
import * as ui from '@UI/generalUI';
import { aiHistoryPath } from '@/filePaths';
import { filterGitKeep } from '@/utils/common';

export async function deleteChats(): Promise<void> {
    try {
        const savedChats = await fs.readdir(aiHistoryPath);

        if (savedChats.length === 0) {
            console.log('No active chat sessions found.');

            return;
        }

        const chatToDelete = await ui.searchSelectAndReturnFromArray({
            itemsArray: filterGitKeep(savedChats),
            prompt: 'Select a chat to delete: '
        });

        await fs.rmdir(`${aiHistoryPath}/${chatToDelete}`, { recursive: true });

        console.log(`Chat ${chatToDelete} has been deleted.`);
    } catch (error) {
        console.error('Error deleting chat:', (error as Error).message);
        throw error;
    }
}
