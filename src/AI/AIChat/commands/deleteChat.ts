import * as fs from 'fs/promises';
import * as ui from '@/UI/generalUI';
import { aiHistoryPath } from '@/filePaths';
import { filterGitKeep } from '@/utils/common';

export async function deleteChats(): Promise<void> {
    try {
        const savedChats = await fs.readdir(aiHistoryPath);

        if (savedChats.length === 0) {
            console.log('No active chat sessions found.');

            return;
        }

        const items = filterGitKeep(savedChats);
        const chatToDelete = await ui.searchSelectAndReturnFromArray({
            itemsArray: items,
            prompt: 'Select a chat to delete',
            header: `${items.length} saved chat(s)`,
            details: async (name) => {
                try {
                    const dataPath = `${aiHistoryPath}/${name}/${name}.json`;
                    const data = JSON.parse(await fs.readFile(dataPath, 'utf-8')) as {
                        provider?: string; model?: string; role?: string;
                        temperature?: number; chatHistory?: unknown[]; summary?: string;
                    };

                    return [
                        `chat: ${name}`,
                        `provider: ${data.provider ?? '?'}`,
                        `model: ${data.model ?? '?'}`,
                        `role: ${data.role ?? '?'}`,
                        `turns: ${data.chatHistory?.length ?? 0}`,
                        '',
                        '--- summary ---',
                        (data.summary ?? '(no summary)').slice(0, 4000),
                    ].join('\n');
                } catch (e: unknown) {
                    return `Failed to read chat: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        });

        await fs.rmdir(`${aiHistoryPath}/${chatToDelete}`, { recursive: true });

        console.log(`Chat ${chatToDelete} has been deleted.`);
    } catch (error) {
        console.error('Error deleting chat:', (error as Error).message);
        throw error;
    }
}
